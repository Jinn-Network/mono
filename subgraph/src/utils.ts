import {
  BigInt,
  Bytes,
  ByteArray,
  ethereum,
  log,
  crypto,
} from "@graphprotocol/graph-ts";

import { Operator } from "../generated/schema";

// ────────────────────────────────────────────────────────────────────────────
// Tier enum strings — must mirror schema.graphql ExecutionTier.
// ────────────────────────────────────────────────────────────────────────────
export const TIER_STRINGS: Array<string> = [
  "SELF_SIGNED", // 0
  "COMMITTED",   // 1
  "CONSENSUS",   // 2
  "ATTESTED",    // 3
  "PROVED",      // 4
];
export const TIER_UNKNOWN: string = "UNKNOWN";

// ────────────────────────────────────────────────────────────────────────────
// Operator helpers
// ────────────────────────────────────────────────────────────────────────────
export function operatorIdFromAgentId(agentId: BigInt): string {
  return agentId.toString();
}

export function loadOrCreateOperator(
  agentId: BigInt,
  blockTimestamp: BigInt,
  blockNumber: BigInt,
  txHash: Bytes,
  ownerHint: Bytes | null,
): Operator {
  let id = operatorIdFromAgentId(agentId);
  let op = Operator.load(id);
  if (op == null) {
    op = new Operator(id);
    op.agentId = agentId;
    op.owner = ownerHint === null ? Bytes.empty() : (ownerHint as Bytes);
    op.registeredAt = blockTimestamp;
    op.registeredBlock = blockNumber;
    op.registeredTx = txHash;
    op.lastUpdatedAt = blockTimestamp;
  }
  return op as Operator;
}

// ────────────────────────────────────────────────────────────────────────────
// Metadata-key parsing
//
// Recognised execution kinds map to ExecutionKind enum values in the schema.
// Per the payload schema spec (jinn-mono-g7h §6), ONLY `envelope` and
// `evaluation` produce Execution rows in v1. `intent:` and `license:` are
// RESERVED prefixes — operators publishing under those keys today fall through
// to the MetadataEntry catch-all (so the rows stay visible) but do NOT get an
// Execution row until their own specs land.
// ────────────────────────────────────────────────────────────────────────────
export class ParsedKey {
  kind: string;     // "ENVELOPE" | "EVALUATION" | "OTHER"
  cid: string;      // suffix after the first ":"
  recognised: bool; // true only for active execution-kind prefixes

  constructor() {
    this.kind = "OTHER";
    this.cid = "";
    this.recognised = false;
  }
}

export function parseMetadataKey(metadataKey: string): ParsedKey {
  let result = new ParsedKey();

  let idx = metadataKey.indexOf(":");
  if (idx <= 0) {
    return result;
  }
  let prefix = metadataKey.substr(0, idx);
  let suffix = metadataKey.substr(idx + 1);
  result.cid = suffix;

  if (prefix == "envelope") {
    result.kind = "ENVELOPE";
    result.recognised = true;
  } else if (prefix == "evaluation") {
    result.kind = "EVALUATION";
    result.recognised = true;
  } else {
    // intent: and license: are reserved-but-unimplemented (g7h §6).
    // All other prefixes fall through here; the MetadataEntry catch-all
    // surfaces them without producing an Execution row.
    result.kind = "OTHER";
    result.recognised = false;
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Payload decoding for envelope/evaluation v1 tuple:
//   (uint8 version, uint8 tier, bytes32 manifestHash,
//    bytes attestationQuoteCid, bytes32 sourceMeasurement)
//
// version must equal 1; tier must be in 0..4. If anything fails to decode
// cleanly, we set ok=false and leave the typed fields zeroed. The raw
// payload bytes are always stored separately for forward-compat.
//
// Per the DR (§4.2), the exact byte layout is deferred to a follow-up spec
// (`jinn-mono-g7h`). This decoder follows the documented provisional layout
// and is written so it can be swapped out cleanly.
// ────────────────────────────────────────────────────────────────────────────
export class DecodedPayload {
  ok: bool;
  version: i32;
  tierRaw: i32;
  tierString: string;
  manifestHash: Bytes;
  attestationQuoteCid: Bytes; // raw multibase-decoded CID bytes (g7h §4)
  sourceMeasurement: Bytes;

  constructor() {
    this.ok = false;
    this.version = 0;
    this.tierRaw = -1;
    this.tierString = TIER_UNKNOWN;
    this.manifestHash = Bytes.empty();
    this.attestationQuoteCid = Bytes.empty();
    this.sourceMeasurement = Bytes.empty();
  }
}

export function decodeExecutionPayload(payload: Bytes): DecodedPayload {
  let result = new DecodedPayload();

  if (payload.length == 0) {
    return result;
  }

  // ABI-decode (uint8,uint8,bytes32,bytes,bytes32)
  let decoded = ethereum.decode("(uint8,uint8,bytes32,bytes,bytes32)", payload);
  if (decoded === null) {
    log.warning("decodeExecutionPayload: ethereum.decode returned null (len={})", [
      payload.length.toString(),
    ]);
    return result;
  }
  let tuple = decoded.toTuple();
  if (tuple.length != 5) {
    log.warning("decodeExecutionPayload: tuple has wrong arity ({})", [
      tuple.length.toString(),
    ]);
    return result;
  }

  let version = tuple[0].toI32();
  let tier = tuple[1].toI32();
  let manifestHash = tuple[2].toBytes();
  let attestationQuoteBytes = tuple[3].toBytes();
  let sourceMeasurement = tuple[4].toBytes();

  if (version != 1) {
    log.warning("decodeExecutionPayload: unsupported version {} (expected 1)", [
      version.toString(),
    ]);
    return result;
  }
  // V1 admits only {0=self-signed, 1=committed, 3=attested}. Tiers 2 (consensus)
  // and 4 (proved) are V2+ — aligned with EvidenceTierSchema in
  // client/src/types/envelope.ts (PR #37 fix 44cc949b).
  if (tier != 0 && tier != 1 && tier != 3) {
    log.warning(
      "decodeExecutionPayload: V1 rejects tier {} (admits only 0,1,3)",
      [tier.toString()],
    );
    return result;
  }

  // Per-tier validity (g7h §5, strict mode):
  //   tier ∈ {0,1}: attestationQuoteCid MUST be empty AND sourceMeasurement MUST be zero.
  //   tier === 3:  attestationQuoteCid MUST be non-empty AND sourceMeasurement MUST be non-zero.
  let requiresAttestation = tier == 3;
  let hasQuote = attestationQuoteBytes.length > 0;
  let measurementIsZero = sourceMeasurement.length == 0 || isAllZeroBytes(sourceMeasurement);
  let hasMeasurement = !measurementIsZero;
  if (requiresAttestation != hasQuote || requiresAttestation != hasMeasurement) {
    log.warning(
      "decodeExecutionPayload: tier-field mismatch (tier={}, hasQuote={}, hasMeasurement={})",
      [tier.toString(), hasQuote ? "true" : "false", hasMeasurement ? "true" : "false"],
    );
    return result;
  }

  result.ok = true;
  result.version = version;
  result.tierRaw = tier;
  result.tierString = TIER_STRINGS[tier];
  result.manifestHash = manifestHash;
  // attestationQuoteCid is raw multibase-decoded CID bytes (g7h §4). Stored
  // verbatim; consumers reconstruct the textual CID at read time.
  result.attestationQuoteCid = attestationQuoteBytes;
  result.sourceMeasurement = sourceMeasurement;
  return result;
}

function isAllZeroBytes(b: Bytes): bool {
  for (let i = 0; i < b.length; i++) {
    if (b[i] != 0) return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Execution / MetadataEntry id helpers
// ────────────────────────────────────────────────────────────────────────────
export function executionId(agentId: BigInt, manifestHash: Bytes): string {
  return agentId.toString() + "-" + manifestHash.toHexString();
}

/**
 * Stable id when we don't (yet) have a manifest hash — fall back to keccak of
 * the metadata key. We keep this id stable across re-publishes of the same
 * metadata key so reorgs / overwrites land on the same entity.
 */
export function executionIdFallback(agentId: BigInt, metadataKey: string): string {
  let keyBytes = Bytes.fromUTF8(metadataKey);
  let hash = changetype<Bytes>(crypto.keccak256(keyBytes));
  return agentId.toString() + "-" + hash.toHexString();
}

export function metadataEntryId(agentId: BigInt, metadataKey: string): string {
  let keyBytes = Bytes.fromUTF8(metadataKey);
  let hash = changetype<Bytes>(crypto.keccak256(keyBytes));
  return agentId.toString() + "-" + hash.toHexString();
}

// ────────────────────────────────────────────────────────────────────────────
// RouterJob lookup / linking helpers
// ────────────────────────────────────────────────────────────────────────────
export function routerJobId(requestId: Bytes): string {
  return requestId.toHexString();
}

// ────────────────────────────────────────────────────────────────────────────
// Manifest-ref extraction from feedback
//
// Reputation `giveFeedback(...)` does not have a manifest-CID parameter, so we
// stash the manifest reference inside `feedbackURI` (canonical) or `tag2`
// (fallback) per the DR §4.3. Recognised forms:
//   • "manifest:<cid>"            — explicit prefix
//   • "ipfs://<cid>"              — bare ipfs URL
//   • bare bafy… / Qm… CID        — raw CID
//
// Returns null if no manifest reference can be parsed.
// ────────────────────────────────────────────────────────────────────────────
export function parseManifestRef(feedbackURI: string, tag2: string): string | null {
  let candidates: Array<string> = [feedbackURI, tag2];
  for (let i = 0; i < candidates.length; i++) {
    let s = candidates[i];
    if (s.length == 0) {
      continue;
    }
    if (s.startsWith("manifest:")) {
      return s.substr("manifest:".length);
    }
    if (s.startsWith("ipfs://")) {
      return s.substr("ipfs://".length);
    }
    if (s.startsWith("bafy") || s.startsWith("Qm")) {
      return s;
    }
  }
  return null;
}
