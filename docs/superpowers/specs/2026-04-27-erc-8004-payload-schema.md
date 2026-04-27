# ERC-8004 `setMetadata` payload schema v1

**Version:** 1.0
**Date:** 2026-04-27
**Status:** Decided. Binding interface. Subgraph (`jinn-mono-fud`) and Identity-Registry client (`jinn-mono-3zk`) both consume this schema directly.
**Beads:** `jinn-mono-g7h` (this spec); related `jinn-mono-3zk`, `jinn-mono-fud`, `jinn-mono-9jg`, `jinn-mono-2ff`, `jinn-mono-al7`.
**Related:**

- `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md` — entity model decision (§4.2 establishes the payload, defers exact byte layout here; §9 enumerates what this schema must support).
- `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` — execution envelope + TEE scope; this schema must align with the tier ladder it commits to.
- `docs/research/2026-04-23-verifiability-traceability.md` — §5 canonical tier ladder (`self-signed` → `committed` → `consensus` → `attested` → `proved`) and per-tier field commitments.
- `spec/2026-04-21-agentic-data-substrate.md` — Tier 3 §9 license tags (deferred to its own spec; reserved key prefix here).
- ERC-8004 reference contracts: pinned at `erc-8004/erc-8004-contracts@0463311492b3a7fc5fdb6990231cce721ff6cf97` (staged copy at `/tmp/erc8004-ref/`).

## 1. Purpose

This spec fixes the byte layout of the `metadataValue` argument that operators pass to `IdentityRegistry.setMetadata(agentId, metadataKey, metadataValue)` when they anchor a per-execution artifact (envelope, evaluation) against their operator agent NFT.

The payload commits, **on chain, per `setMetadata` call**, to four trust-relevant facts about the artifact named by `metadataKey`:

1. **Schema version** — so indexers can route bytes by version cleanly.
2. **Evidence tier** — the operator's declared tier on the canonical ladder. This is the only tier-shaped signal indexers can read without an IPFS round-trip.
3. **Manifest hash** — keccak256 of the canonical manifest bytes; identical to the `evidenceHash` JinnRouter already commits in `claimDelivery`. This makes the `setMetadata` call cross-checkable against router state and against the IPFS-resolved CID in the metadata key.
4. **Attestation pointers** — for tiers ≥ `attested`, an IPFS CID for the TEE quote and the `bytes32` enclave measurement that the operator's published source must reproducibly build to.

### 1.1 Why an inline payload, not a CID pointer to off-chain data

The on-chain bytes serve **filtering and integrity**, not data delivery. Two requirements drive the inline shape:

- **Cheap, atomic tier filtering at the indexer.** A subgraph asked "give me all attested envelopes from the last 30 days" must answer from event data alone. If the tier lived behind a CID, every event would require an IPFS fetch before filtering, which is the opposite of cheap.
- **Self-describing commitment.** The `evidenceHash`/`manifestHash` is what JinnRouter already commits. Anchoring it again, inline, in the `setMetadata` event makes the on-chain commitment durable across surfaces (router event, identity-registry event, IPFS manifest body) without a chain of indirection.

Everything that **doesn't** need cheap on-chain access — the manifest body, the trajectory log, the TEE quote bytes, the source bundle, the `OUTPUTS.json` — stays on IPFS. The CIDs for those bodies live in either the metadata key (`<kind>:<cid>`) or the inline payload (`attestationQuoteCid`). The on-chain payload is the **filtering header**, not the data.

Ceiling: a single cold `SSTORE` for the metadata mapping plus the calldata cost. At the v1 sizes below, the typical per-tier costs on Base are roughly:

| Tier | Encoded payload size | Approx Base cost | Note |
|---|---|---|---|
| self-signed | 160 head + 32 zero-length tail = **192 bytes** | ~$0.005 (base mainnet) | One SSTORE; no TEE fields. |
| committed | same as self-signed | same | Field shape identical to self-signed. |
| consensus | same as self-signed | same | No on-payload diff vs committed. |
| attested | 160 head + 32 length + 64 padded CID (36-byte CIDv1) = **256 bytes** | ~$0.008 | Adds quote CID and source measurement. |
| proved | same as attested | same | zk proof reference is in the manifest body, not the payload. |

These dominate the per-publish cost; the rest is event indexing and one indexed-key keccak.

## 2. Versioning

The first byte of the encoded tuple is `version: uint8`. This spec defines `version = 1`. The version field is mandatory and never elided.

**Forward-compatibility rules:**

- **Reject unknown versions.** An indexer or client that decodes a payload with a `version` it does not understand MUST treat the payload as **malformed for its own purposes** and skip the event cleanly (still record the raw bytes, but emit no decoded `Execution` row, or emit one with `decoded = false`). It MUST NOT guess.
- **Append, never re-order.** Future schema versions add fields at the **end** of the tuple. Existing fields keep their slot. This way an indexer pinned to v1 can still locate `tier`, `manifestHash`, etc. in a v2 payload's prefix using the v1 field offsets — but it MUST NOT do so unless it explicitly opts in to "best-effort prefix decode" of newer versions.
- **Never reuse a version number.** If a v1 payload semantics change is needed, mint a v2 with the new semantics; do not patch v1 in place.
- **Indexer behavior on unknown version.** Recommended pattern: emit a `MetadataDecodeFailure` warning entity with `(agentId, metadataKey, version, rawBytes)`, so operators have a debug surface. Continue indexing. Do not halt the subgraph.

The `version` byte sits inside the ABI tuple's head section as a `uint8` (right-padded to 32 bytes by Solidity ABI encoding). It is **not** a separate raw byte prefix outside the tuple; it is the first field of the encoded struct. This keeps the payload a single `abi.encode(...)` call and a single `abi.decode(...)` call on the receiving side.

## 3. Encoding

The payload is the result of `abi.encode(...)` over the v1 tuple. ABI encoding splits into a **head** (fixed-size and offsets) and a **tail** (dynamic-length data).

### 3.1 v1 tuple, in declaration order

```solidity
abi.encode(
    uint8   version,             // = 1
    uint8   tier,                // 0..4
    bytes32 manifestHash,        // = JinnRouter evidenceHash
    bytes   attestationQuoteCid, // dynamic; empty (0x) for tier < 3
    bytes32 sourceMeasurement    // 0x00...00 for tier < 3
)
```

### 3.2 Head / tail layout (canonical Solidity ABI)

The head is **5 × 32 = 160 bytes**. Tail bytes follow immediately. Each head slot is 32 bytes:

| Slot | Offset | Field | Encoding |
|---|---|---|---|
| 0 | `0x000` | `version` | `uint8`, left-padded with zeros to 32 bytes (`0x00...01` for v1) |
| 1 | `0x020` | `tier` | `uint8`, left-padded with zeros to 32 bytes |
| 2 | `0x040` | `manifestHash` | `bytes32`, raw |
| 3 | `0x060` | offset of `attestationQuoteCid` tail | `uint256`, equals `0xa0` (160 bytes — the start of the tail, immediately after the 5-slot head) |
| 4 | `0x080` | `sourceMeasurement` | `bytes32`, raw |

Tail (starts at `0x0a0`):

| Tail offset | Field | Encoding |
|---|---|---|
| `0xa0` | `attestationQuoteCid.length` | `uint256` length prefix |
| `0xc0` | `attestationQuoteCid` raw bytes | right-padded to a 32-byte multiple |

For the empty case (`attestationQuoteCid = 0x`), the tail is exactly one 32-byte slot of zeros (the length prefix `0`), so the total payload size is `0xa0 + 0x20 = 0xc0` (**192 bytes**). When `attestationQuoteCid` is non-empty (e.g. a 36-byte CIDv1), the tail is `0x20` (length prefix) + `ceil(len / 32) * 32` (right-padded payload), e.g. 32 + 64 = 96 bytes for a 36-byte CID, giving a total of 256 bytes.

> **Note on field ordering.** `sourceMeasurement` is declared **after** `attestationQuoteCid` in the tuple but lives in head slot 4 (a fixed-size `bytes32`), while the offset to the dynamic `attestationQuoteCid` lives in head slot 3. This is exactly how Solidity ABI encoding handles a `(uint8, uint8, bytes32, bytes, bytes32)` tuple: each fixed-size field gets a head slot in declaration order, dynamic fields get an offset slot in declaration order, and the tails follow at the end. Decoders that use the tuple type signature directly (viem's `decodeAbiParameters`, web3.py, ethers) handle this automatically; only hand-rolled decoders need to know.

### 3.3 Worked example — tier=committed envelope, empty quote

Inputs:

- `version = 1`
- `tier = 1` (committed)
- `manifestHash = 0x1111...1111` (32 bytes of `0x11`)
- `attestationQuoteCid = 0x` (empty)
- `sourceMeasurement = 0x0000...0000`

Encoded (192 bytes, hex, slot boundaries marked with `|`):

```
0000000000000000000000000000000000000000000000000000000000000001 |  // version = 1
0000000000000000000000000000000000000000000000000000000000000001 |  // tier = 1 (committed)
1111111111111111111111111111111111111111111111111111111111111111 |  // manifestHash
00000000000000000000000000000000000000000000000000000000000000a0 |  // offset to attestationQuoteCid tail = 160
0000000000000000000000000000000000000000000000000000000000000000 |  // sourceMeasurement = 0
0000000000000000000000000000000000000000000000000000000000000000    // attestationQuoteCid.length = 0
```

Concatenated: `0x` + 192 bytes (384 hex chars). See §8 for full normative test vectors.

### 3.4 Canonicalization

`abi.encode` is deterministic for a fixed schema and inputs — there is no canonicalization step beyond what the encoder already does. Two operators encoding the same logical tuple produce byte-identical payloads. Indexers MUST decode using the v1 tuple signature; they MUST NOT re-canonicalize or re-pack.

## 4. Schema v1

Fields, in declaration / encoding order:

| # | Field | Type | Required | Semantics |
|---|---|---|---|---|
| 1 | `version` | `uint8` | yes | Schema version. MUST equal `1` for this spec. |
| 2 | `tier` | `uint8` | yes | Evidence tier on the canonical ladder. **V1 admits only `{0=self-signed, 1=committed, 3=attested}`** — aligned with `EvidenceTierSchema` in `client/src/types/envelope.ts` (PR #37 fix `44cc949b`). Values `2` (consensus) and `4` (proved) are V2+ — reserved here; indexers MUST treat them as `MetadataDecodeFailure` in V1. The numeric gap is intentional so a future schema-version bump (v2) can re-admit `2` and `4` without renumbering. |
| 3 | `manifestHash` | `bytes32` | yes | `keccak256` of the canonical manifest bytes (envelope or evaluation). MUST equal the `evidenceHash` JinnRouter committed via `claimDelivery` for the same execution. Cross-check is normative for indexers (§5.6). |
| 4 | `attestationQuoteCid` | `bytes` | conditional (see §5) | IPFS CID of the TEE attestation quote. Empty (`0x`) for `tier < 3`; non-empty for `tier ≥ 3`. **Encoding:** the **raw multibase-decoded CID bytes** (the binary form), i.e. for a CIDv1 the multicodec-prefixed bytes (`<version-varint><codec-varint><multihash>`); for a CIDv0 the raw 34-byte multihash (`0x12 0x20 <sha256-32>`). Indexers MUST NOT assume any text encoding. **Rationale:** keeps the on-chain bytes minimal (CIDv1 raw is ~36 bytes vs. ~59 base32 chars), and matches how IPFS clients reconstruct CIDs from raw bytes. |
| 5 | `sourceMeasurement` | `bytes32` | conditional (see §5) | `bytes32` enclave measurement that the operator's **published source** must reproducibly build to. Zero (`0x00...00`) for `tier < 3`; non-zero for `tier ≥ 3`. The exact measurement format is TEE-specific (Nitro PCR0, TDX MRTD, SEV-SNP `MEASUREMENT`); the schema treats it opaquely as 32 bytes — TEE platforms wider than 32 bytes (e.g. SGX MRENCLAVE is 32; some platforms exceed) are addressed by the TEE envelope spec via additional manifest-body fields, not by widening this slot. |

For `kind ∈ {envelope, evaluation}` the schema is identical. Per-kind interpretation is the responsibility of the manifest body on IPFS, not the on-chain payload.

## 5. Per-tier validity rules

Normative validity table. Indexers MUST validate every payload against these rules.

| Tier | Name | `attestationQuoteCid` | `sourceMeasurement` | Notes |
|---|---|---|---|---|
| 0 | `self-signed` | MUST be empty (`0x`) | MUST be zero (`0x00...00`) | The signed manifest is the only commitment. |
| 1 | `committed` | MUST be empty (`0x`) | MUST be zero (`0x00...00`) | Same on-payload constraints as self-signed; the on-chain `JinnRouter.evidenceHash` IS the additional commitment. |
| 2 | `consensus` | — | — | **NOT ADMITTED IN V1.** Reserved for V2+ when multi-evaluator consensus enters the schema. Indexers MUST reject `tier=2` payloads in V1 as `MetadataDecodeFailure`. |
| 3 | `attested` | MUST be non-empty | MUST be non-zero | Operator declares a TEE-attested execution. The IPFS body at `attestationQuoteCid` MUST contain the vendor quote; the operator's published source MUST reproducibly build to `sourceMeasurement`. Verifying both is off-chain (vendor cert chain + reproducible build); the on-chain payload pins **what** to verify against. |
| 4 | `proved` | — | — | **NOT ADMITTED IN V1.** Reserved for V2+ when zkVM proof references enter the schema. Indexers MUST reject `tier=4` payloads in V1 as `MetadataDecodeFailure`. |

### 5.1 Indexer behavior on rule violation

An indexer that decodes a payload that violates the table above (e.g. `tier=3` with `attestationQuoteCid = 0x`, or `tier=0` with `sourceMeasurement != 0`) MUST take one of two actions, configurable per indexer deployment:

- **Reject (strict mode, default).** Emit `MetadataDecodeFailure(agentId, metadataKey, reason)`. Do not produce an `Execution` row. Continue indexing other events.
- **Downgrade-with-warning (lenient mode, opt-in).** Emit `MetadataDowngrade(agentId, metadataKey, declared, effective)`. Produce an `Execution` row with `tier = effective`, where `effective` is the highest tier consistent with the *actual* fields present (e.g. a `tier=3` payload with empty quote downgrades to `effective = committed`). Lenient mode exists for buyer-side robustness; strict mode is the protocol default.

A buyer-facing query MUST be able to filter on **declared tier** vs **effective tier** independently. Conflating them hides operator misbehavior.

### 5.2 Cross-check against JinnRouter

Indexers MUST verify that `manifestHash` equals the `evidenceHash` JinnRouter committed for the same execution, where joinable. The join key is the agent's Safe (operator EOA chain) and a window match against `JinnRouter` request/delivery events. A mismatch is reportable but **non-fatal** — it is logged, the `Execution` row is flagged `routerCrossCheck = mismatch`, and downstream consumers decide whether to trust the row. This avoids the indexer becoming a single point of strict failure when JinnRouter and IdentityRegistry events arrive out-of-order.

## 6. Key prefix conventions

The `metadataKey` argument to `setMetadata` is a string of the form `<kind>:<cid>`, where `<cid>` is the **base32-encoded CIDv1** (textual form) of the artifact body on IPFS. The textual form lives in the key (because it is what humans paste into URLs and logs); the binary form, where applicable, lives in the payload (`attestationQuoteCid`).

### 6.1 Defined prefixes (v1)

| Prefix | Meaning | Required payload schema | Subgraph entity |
|---|---|---|---|
| `envelope:<cid>` | Restoration manifest commitment. The `<cid>` resolves to the signed `jinn.execution.v1` manifest (or `portfolio.v0.manifest.v1` until envelope-v1 lands). | This spec, `kind=envelope` interpretation. | `Execution { kind: "envelope", … }` |
| `evaluation:<cid>` | Verdict manifest commitment. The `<cid>` resolves to the signed evaluation manifest. | This spec, `kind=evaluation` interpretation. | `Execution { kind: "evaluation", parent: <envelope> }` |

### 6.2 Reserved prefixes (future, not yet defined)

| Prefix | Reserved for | Spec | Notes |
|---|---|---|---|
| `intent:<cid>` | Intent claim — the operator's commitment to the intent body they accepted. | Future spec. | Anchors the *intent CID* the operator restored against, supporting cross-operator intent dedup. |
| `license:<cid>` | Per-trajectory rights/license tag (substrate-thesis Tier 3 §9). | Future spec — `agentic-data-substrate.md` Tier 3 §9. | Body format (license tag bytes) is not yet specified; do not emit. |

**What "reserved" means:** indexers MUST NOT use these prefixes for any other purpose. If a `setMetadata` call lands today with `metadataKey = "intent:..."` or `"license:..."`, the indexer MUST emit `MetadataReservedKey(agentId, metadataKey)` and otherwise ignore the event (no `Execution` row). When the future spec lands, it will define the payload schema (which may or may not be this same v1 tuple — likely a different tuple version, e.g. `version=2` for a license-specific shape).

### 6.3 Schema evolution to admit new prefixes

To admit a new prefix, the spec author MUST:

1. Update §6.1 to add the prefix and define its required payload schema.
2. If the payload differs from this v1 tuple, mint a new schema version (`version=2`, etc.) and update §2 to reference it.
3. Update the subgraph (`jinn-mono-fud`) handlers to materialize the new entity.
4. Note the change in this spec's revision history.

A new prefix MUST NOT silently overload an existing prefix's semantics. Indexers detect the prefix from `indexedMetadataKey` (the indexed `string` arg in `MetadataSet`).

### 6.4 Subgraph filtering by `indexedMetadataKey`

The `MetadataSet` event signature is:

```solidity
event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
```

The **`indexedMetadataKey` is `keccak256(metadataKey)`** (Solidity hashes indexed string topics). Subgraphs filter at the **handler level** by examining the non-indexed `metadataKey` string copy and matching its prefix (`startsWith("envelope:")`, `startsWith("evaluation:")`, etc.). Topic-level filtering by exact key is possible (`keccak256("envelope:bafy...")` per CID) but generally not useful — the subgraph wants to subscribe to **all** envelope events, not one at a time.

Recommended subgraph manifest pattern (`subgraph.yaml`):

```yaml
dataSources:
  - kind: ethereum/contract
    name: IdentityRegistry
    source:
      address: "0x8004..."  # canonical 8004 deployment per chain
      abi: IdentityRegistry
    mapping:
      kind: ethereum/events
      eventHandlers:
        - event: MetadataSet(indexed uint256, indexed string, string, bytes)
          handler: handleMetadataSet
```

The `handleMetadataSet` handler dispatches by `metadataKey` prefix; see §7.1 for pseudocode.

## 7. Decoding pseudocode

### 7.1 AssemblyScript subgraph handler

```typescript
import { Bytes, BigInt, log } from "@graphprotocol/graph-ts"
import { MetadataSet } from "../generated/IdentityRegistry/IdentityRegistry"
import { Execution, Operator, MetadataDecodeFailure } from "../generated/schema"
import { ethereum } from "@graphprotocol/graph-ts"

export function handleMetadataSet(event: MetadataSet): void {
  const key = event.params.metadataKey
  const value = event.params.metadataValue
  const agentId = event.params.agentId

  // Dispatch by prefix
  if (key.startsWith("envelope:")) {
    decodeAndStoreExecution(agentId, key, "envelope", value, event)
  } else if (key.startsWith("evaluation:")) {
    decodeAndStoreExecution(agentId, key, "evaluation", value, event)
  } else if (key == "agentWallet") {
    // Reserved by IdentityRegistry — handled separately
  } else if (key.startsWith("intent:") || key.startsWith("license:")) {
    log.warning("reserved-but-unimplemented prefix: {}", [key])
    // No Execution row yet. Log via MetadataDecodeFailure if desired.
  } else {
    log.info("ignoring unknown metadata key: {}", [key])
  }
}

function decodeAndStoreExecution(
  agentId: BigInt,
  key: string,
  kind: string,
  raw: Bytes,
  event: MetadataSet,
): void {
  // ABI tuple: (uint8, uint8, bytes32, bytes, bytes32)
  const tuple = ethereum.decode(
    "(uint8,uint8,bytes32,bytes,bytes32)",
    raw,
  )
  if (tuple === null) {
    emitDecodeFailure(agentId, key, "abi-decode-failed", event)
    return
  }
  const t = tuple.toTuple()
  const version = t[0].toI32()
  const tier = t[1].toI32()
  const manifestHash = t[2].toBytes()
  const quoteCid = t[3].toBytes()
  const sourceMeasurement = t[4].toBytes()

  if (version != 1) {
    emitDecodeFailure(agentId, key, "unknown-version", event)
    return
  }
  if (tier > 4) {
    emitDecodeFailure(agentId, key, "unknown-tier", event)
    return
  }

  // Per-tier validity (strict mode)
  const requiresAttestation = tier >= 3
  const hasQuote = quoteCid.length > 0
  const hasMeasurement = !isZeroBytes32(sourceMeasurement)
  if (requiresAttestation != hasQuote || requiresAttestation != hasMeasurement) {
    emitDecodeFailure(agentId, key, "tier-field-mismatch", event)
    return
  }

  const exec = new Execution(key) // id = "<kind>:<cid>"
  exec.kind = kind
  exec.operator = agentId.toString()
  exec.tier = tier
  exec.declaredTier = tier
  exec.manifestHash = manifestHash
  exec.attestationQuoteCid = quoteCid
  exec.sourceMeasurement = sourceMeasurement
  exec.cid = key.split(":")[1]
  exec.txHash = event.transaction.hash
  exec.blockNumber = event.block.number
  exec.timestamp = event.block.timestamp
  exec.save()
}
```

### 7.2 TypeScript client (viem)

```typescript
import { decodeAbiParameters, type Hex } from "viem"

export type DecodedPayload = {
  version: number
  tier: 0 | 1 | 2 | 3 | 4
  manifestHash: Hex
  attestationQuoteCid: Hex // raw bytes, hex-encoded
  sourceMeasurement: Hex
}

const PAYLOAD_TUPLE = [
  { name: "version", type: "uint8" },
  { name: "tier", type: "uint8" },
  { name: "manifestHash", type: "bytes32" },
  { name: "attestationQuoteCid", type: "bytes" },
  { name: "sourceMeasurement", type: "bytes32" },
] as const

export function decodePayload(raw: Hex): DecodedPayload {
  const [version, tier, manifestHash, attestationQuoteCid, sourceMeasurement] =
    decodeAbiParameters(PAYLOAD_TUPLE, raw)

  if (version !== 1) {
    throw new Error(`unsupported payload version ${version}`)
  }
  if (tier > 4) {
    throw new Error(`unknown tier ${tier}`)
  }

  // Per-tier validity
  const requiresAttestation = tier >= 3
  const hasQuote = attestationQuoteCid !== "0x" && attestationQuoteCid.length > 2
  const hasMeasurement =
    sourceMeasurement !==
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  if (requiresAttestation !== hasQuote || requiresAttestation !== hasMeasurement) {
    throw new Error(`tier ${tier} field-mismatch`)
  }

  return {
    version: Number(version),
    tier: Number(tier) as DecodedPayload["tier"],
    manifestHash,
    attestationQuoteCid,
    sourceMeasurement,
  }
}

// Encoding (operator side):
import { encodeAbiParameters } from "viem"

export function encodePayload(p: Omit<DecodedPayload, "version">): Hex {
  return encodeAbiParameters(PAYLOAD_TUPLE, [
    1,
    p.tier,
    p.manifestHash,
    p.attestationQuoteCid,
    p.sourceMeasurement,
  ])
}
```

## 8. Test vectors

Three concrete cases. For each: human-readable input, the encoded bytes (full hex, no `0x` prefix on the encoded body for readability — implementations prepend `0x` when handing to the contract), and the expected round-trip decoded values.

### 8.1 Test vector A — tier=self-signed envelope, no attestation

**Input:**

- `version`: `1`
- `tier`: `0` (self-signed)
- `manifestHash`: `0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
- `attestationQuoteCid`: `0x` (empty)
- `sourceMeasurement`: `0x0000000000000000000000000000000000000000000000000000000000000000`

**Expected encoded bytes (192 bytes):**

```
0x
0000000000000000000000000000000000000000000000000000000000000001
0000000000000000000000000000000000000000000000000000000000000000
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
00000000000000000000000000000000000000000000000000000000000000a0
0000000000000000000000000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000
```

**Round-trip decoded:** matches input exactly. Validates against §5 rules (tier 0: empty quote, zero measurement).

### 8.2 Test vector B — tier=committed envelope, no attestation

**Input:**

- `version`: `1`
- `tier`: `1` (committed)
- `manifestHash`: `0x1111111111111111111111111111111111111111111111111111111111111111`
- `attestationQuoteCid`: `0x`
- `sourceMeasurement`: `0x0000000000000000000000000000000000000000000000000000000000000000`

**Expected encoded bytes (192 bytes):**

```
0x
0000000000000000000000000000000000000000000000000000000000000001
0000000000000000000000000000000000000000000000000000000000000001
1111111111111111111111111111111111111111111111111111111111111111
00000000000000000000000000000000000000000000000000000000000000a0
0000000000000000000000000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000
```

**Round-trip decoded:** matches input. Validates (tier 1: same constraints as tier 0).

### 8.3 Test vector C — tier=attested envelope, with TEE quote

**Input:**

- `version`: `1`
- `tier`: `3` (attested)
- `manifestHash`: `0x2222222222222222222222222222222222222222222222222222222222222222`
- `attestationQuoteCid`: raw bytes of a CIDv1 (sha256 dag-pb): `0x01701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31de94391a` (36 bytes — standard CIDv1 raw multihash form: `<version=01><codec=70 dag-pb><multihash 0x12 0x20 + 32-byte sha256>`)
- `sourceMeasurement`: `0x3333333333333333333333333333333333333333333333333333333333333333` (32 bytes of `0x33`)

**Expected encoded bytes (256 bytes — head 160 + tail 32 (length) + 64 (padded payload)):**

Head (5 × 32 = 160 bytes):
```
0000000000000000000000000000000000000000000000000000000000000001  // version
0000000000000000000000000000000000000000000000000000000000000003  // tier=3 (attested)
2222222222222222222222222222222222222222222222222222222222222222  // manifestHash
00000000000000000000000000000000000000000000000000000000000000a0  // offset=0xa0
3333333333333333333333333333333333333333333333333333333333333333  // sourceMeasurement
```

Tail — length prefix (32 bytes) + payload right-padded to 32-byte multiple (36 → 64 bytes):
```
0000000000000000000000000000000000000000000000000000000000000024  // length=36
01701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31  // CID bytes [0..32)
de94391a00000000000000000000000000000000000000000000000000000000  // CID bytes [32..36) + 28 bytes zero-pad
```

**Full hex (256 bytes), confirmed against `viem.encodeAbiParameters`:**

```
0x
0000000000000000000000000000000000000000000000000000000000000001
0000000000000000000000000000000000000000000000000000000000000003
2222222222222222222222222222222222222222222222222222222222222222
00000000000000000000000000000000000000000000000000000000000000a0
3333333333333333333333333333333333333333333333333333333333333333
0000000000000000000000000000000000000000000000000000000000000024
01701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31
de94391a00000000000000000000000000000000000000000000000000000000
```

**Round-trip decoded:** matches input. Validates (tier 3: non-empty quote, non-zero measurement).

> **Implementation note for test fixtures.** Production test suites SHOULD generate these vectors at runtime via `viem.encodeAbiParameters` or `web3.eth.abi.encodeParameters` rather than hand-checking the hex. The hex above is normative for documentation and a sanity check; the encoder is the source of truth at runtime. A test that asserts `encode(decode(bytes)) === bytes` and `decode(encode(struct)) === struct` for each vector is sufficient.

## 9. Open questions (deferred cleanly)

- **Exact TEE attestation quote format.** Whether the bytes referenced by `attestationQuoteCid` are AWS Nitro `nitro_attestation` CBOR docs, Intel TDX TDREPORT/quote, AMD SEV-SNP `AttestationReport` blobs, Phala Phat-contract attestations, or a Jinn-canonical RATS-EAT envelope wrapping any of those — **deferred to the TEE envelope spec** (`2026-04-23-jinn-execution-envelope-tee-scope.md` follow-on design). This payload schema only commits that *some* CID names *some* quote and that the operator's published source builds reproducibly to `sourceMeasurement`; the verifier-side checks live in the TEE spec.
- **Source-measurement field width for >32-byte platforms.** Some attestation platforms (rare today; some TPM-style PCR concatenations) produce measurements wider than 32 bytes. The schema treats `sourceMeasurement` as `bytes32` for v1, which fits Nitro PCR0 (32-byte SHA-384 truncation in practice — actual PCR0 is 48 bytes; vendor verifiers handle the wider value, but the *binding measurement* the operator commits to in the schema can be a Jinn-canonical 32-byte digest of the full vendor measurement). The TEE spec MUST define the canonicalization. If a future platform genuinely needs >32 bytes here, mint `version=2` with a `bytes` field instead.
- **License tag schema for `license:<cid>`.** Reserved prefix in §6.2; deferred to its own spec under the substrate-thesis Tier 3 §9 work (`agentic-data-substrate.md`). Likely a different schema version; do not assume v1 layout.
- **Intent claim payload for `intent:<cid>`.** Reserved prefix; deferred to a separate Phase 1b spec coordinated with the intent posting service.
- **Cross-chain `manifestHash` namespacing.** The `manifestHash` is keccak256 of canonical manifest bytes; on a multi-chain Jinn it is globally unique by birthday-bound but the JinnRouter cross-check (§5.2) is per-chain. The Phase 2 cross-chain identity question (`entity-model-design.md` §11) decides whether to anchor `chainId` here or elsewhere.

## 10. Summary

A 5-field ABI-encoded tuple — **192 bytes** for tiers 0–2 (no attestation), **256 bytes** for tiers 3–4 (with a 36-byte CIDv1 quote pointer) — at roughly $0.005–$0.008 per `setMetadata` call on Base. The schema lets indexers filter by tier and cross-check `manifestHash` against JinnRouter without an IPFS round-trip. Versioned for forward compatibility. Per-tier validity rules are normative. Two key prefixes defined (`envelope`, `evaluation`); two reserved (`intent`, `license`). The on-chain payload is the **filtering header**; the artifact bodies live on IPFS.

---

*End of v1 schema spec. Next coordination point: TEE envelope follow-on design (D1–D4 in `2026-04-23-jinn-execution-envelope-tee-scope.md`) — pin the TEE platform, then the `attestationQuoteCid` body format collapses from "any RATS-EAT-shaped thing" to a concrete profile.*
