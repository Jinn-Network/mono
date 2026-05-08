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
// Per the payload schema spec (jinn-mono-g7h §6), `envelope`, `capture`, and
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

  if (prefix == "envelope" || prefix == "capture") {
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
// Payload decoding.
//
// V1 tuple (5 fields):
//   (uint8 version=1, uint8 tier, bytes32 manifestHash,
//    bytes attestationQuoteCid, bytes32 sourceMeasurement)
//
// V2 tuple (8 fields, append-not-reorder per payload-schema §3):
//   (uint8 version=2, uint8 tier, bytes32 manifestHash,
//    bytes attestationQuoteCid, bytes32 sourceMeasurement,
//    bytes32 codeDigest, string implName, uint8 modeFlag)
//
// We dispatch on the leading `version` byte. Unknown versions decode as
// `ok=false` and the raw payload bytes are still stored separately so a
// future migration can re-decode them.
//
// Spec: docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md §3
//       docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6
// ────────────────────────────────────────────────────────────────────────────
export class DecodedPayload {
  ok: bool;
  version: i32;
  tierRaw: i32;
  tierString: string;
  manifestHash: Bytes;
  attestationQuoteCid: Bytes; // raw multibase-decoded CID bytes (g7h §4)
  sourceMeasurement: Bytes;
  /**
   * Executor mode decoded from the payload. "train" | "frozen".
   * v1 payload ABI tuple does not include mode — reserved for v2.
   * v1 payloads default to "train"; v2 reads it from the modeFlag (0=train, 1=frozen).
   * See docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.
   */
  mode: string;
  /**
   * Executor codeDigest (32 raw bytes) decoded from a v2 payload. Empty for
   * v1 payloads. The caller re-applies the textual `sha256:` prefix when
   * surfacing this on the Execution entity so it matches the off-chain
   * SignedEnvelope shape.
   */
  codeDigest: Bytes;
  /**
   * Executor implementation name decoded from a v2 payload. Empty string for
   * v1 payloads. Surfaced as `Execution.implName` and used as the first
   * dimension of the HarnessRollup identity.
   */
  implName: string;

  constructor() {
    this.ok = false;
    this.version = 0;
    this.tierRaw = -1;
    this.tierString = TIER_UNKNOWN;
    this.manifestHash = Bytes.empty();
    this.attestationQuoteCid = Bytes.empty();
    this.sourceMeasurement = Bytes.empty();
    this.mode = "train"; // default; v1 payload does not encode mode
    this.codeDigest = Bytes.empty();
    this.implName = "";
  }
}

export function decodeExecutionPayload(payload: Bytes): DecodedPayload {
  let result = new DecodedPayload();

  if (payload.length == 0) {
    return result;
  }

  // The ABI-encoded tuple's first 32 bytes hold `uint8 version` (left-padded
  // to 32 bytes by Solidity ABI encoding). Peek at it to decide which tuple
  // shape to decode.
  // Index 31 is the LSB of the first 32-byte word.
  if (payload.length < 32) {
    log.warning("decodeExecutionPayload: payload too short to read version ({} bytes)", [
      payload.length.toString(),
    ]);
    return result;
  }
  let versionByte = payload[31];

  if (versionByte == 1) {
    return decodeV1Tuple(payload, result);
  }
  if (versionByte == 2) {
    return decodeV2Tuple(payload, result);
  }

  log.warning("decodeExecutionPayload: unsupported version {} (expected 1 or 2)", [
    versionByte.toString(),
  ]);
  return result;
}

function decodeV1Tuple(payload: Bytes, result: DecodedPayload): DecodedPayload {
  // ABI-decode (uint8,uint8,bytes32,bytes,bytes32)
  let decoded = ethereum.decode("(uint8,uint8,bytes32,bytes,bytes32)", payload);
  if (decoded === null) {
    log.warning("decodeExecutionPayload: v1 ethereum.decode returned null (len={})", [
      payload.length.toString(),
    ]);
    return result;
  }
  let tuple = decoded.toTuple();
  if (tuple.length != 5) {
    log.warning("decodeExecutionPayload: v1 tuple has wrong arity ({})", [
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
    log.warning("decodeExecutionPayload: v1 dispatch but version={}", [version.toString()]);
    return result;
  }
  if (!validateTierAndAttestation(tier, attestationQuoteBytes, sourceMeasurement)) {
    return result;
  }

  result.ok = true;
  result.version = version;
  result.tierRaw = tier;
  result.tierString = TIER_STRINGS[tier];
  result.manifestHash = manifestHash;
  result.attestationQuoteCid = attestationQuoteBytes;
  result.sourceMeasurement = sourceMeasurement;
  // v1 payload does not encode mode/codeDigest/implName — defaults preserved.
  result.mode = "train";
  return result;
}

function decodeV2Tuple(payload: Bytes, result: DecodedPayload): DecodedPayload {
  // ABI-decode (uint8,uint8,bytes32,bytes,bytes32,bytes32,string,uint8)
  let decoded = ethereum.decode(
    "(uint8,uint8,bytes32,bytes,bytes32,bytes32,string,uint8)",
    payload,
  );
  if (decoded === null) {
    log.warning("decodeExecutionPayload: v2 ethereum.decode returned null (len={})", [
      payload.length.toString(),
    ]);
    return result;
  }
  let tuple = decoded.toTuple();
  if (tuple.length != 8) {
    log.warning("decodeExecutionPayload: v2 tuple has wrong arity ({})", [
      tuple.length.toString(),
    ]);
    return result;
  }

  let version = tuple[0].toI32();
  let tier = tuple[1].toI32();
  let manifestHash = tuple[2].toBytes();
  let attestationQuoteBytes = tuple[3].toBytes();
  let sourceMeasurement = tuple[4].toBytes();
  let codeDigestBytes = tuple[5].toBytes();
  let implName = tuple[6].toString();
  let modeFlag = tuple[7].toI32();

  if (version != 2) {
    log.warning("decodeExecutionPayload: v2 dispatch but version={}", [version.toString()]);
    return result;
  }
  if (!validateTierAndAttestation(tier, attestationQuoteBytes, sourceMeasurement)) {
    return result;
  }
  if (modeFlag != 0 && modeFlag != 1) {
    log.warning("decodeExecutionPayload: v2 modeFlag must be 0 or 1, got {}", [
      modeFlag.toString(),
    ]);
    return result;
  }

  result.ok = true;
  result.version = version;
  result.tierRaw = tier;
  result.tierString = TIER_STRINGS[tier];
  result.manifestHash = manifestHash;
  result.attestationQuoteCid = attestationQuoteBytes;
  result.sourceMeasurement = sourceMeasurement;
  result.codeDigest = codeDigestBytes;
  result.implName = implName;
  result.mode = modeFlag == 1 ? "frozen" : "train";
  return result;
}

function validateTierAndAttestation(
  tier: i32,
  attestationQuoteBytes: Bytes,
  sourceMeasurement: Bytes,
): bool {
  // V1+V2 admit only {0=self-signed, 1=committed, 3=attested}. Tiers 2
  // (consensus) and 4 (proved) are V3+ — aligned with EvidenceTierSchema in
  // client/src/types/envelope.ts.
  if (tier != 0 && tier != 1 && tier != 3) {
    log.warning(
      "decodeExecutionPayload: rejected tier {} (admits only 0,1,3)",
      [tier.toString()],
    );
    return false;
  }
  let requiresAttestation = tier == 3;
  let hasQuote = attestationQuoteBytes.length > 0;
  let measurementIsZero =
    sourceMeasurement.length == 0 || isAllZeroBytes(sourceMeasurement);
  let hasMeasurement = !measurementIsZero;
  if (requiresAttestation != hasQuote || requiresAttestation != hasMeasurement) {
    log.warning(
      "decodeExecutionPayload: tier-field mismatch (tier={}, hasQuote={}, hasMeasurement={})",
      [tier.toString(), hasQuote ? "true" : "false", hasMeasurement ? "true" : "false"],
    );
    return false;
  }
  return true;
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
// V3 task lifecycle id helpers
// ────────────────────────────────────────────────────────────────────────────
export function taskId(taskIdValue: BigInt): string {
  return taskIdValue.toString();
}

export function taskAttemptId(taskIdValue: BigInt, attemptIndex: BigInt): string {
  return taskIdValue.toString() + "-" + attemptIndex.toString();
}

export function verdictId(
  taskIdValue: BigInt,
  attemptIndex: BigInt,
  verdictIndex: BigInt,
): string {
  return (
    taskIdValue.toString() +
    "-" +
    attemptIndex.toString() +
    "-" +
    verdictIndex.toString()
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SolverNet manifest key parsing
//
// `setMetadata(agentId, "solvernet-manifest:<cid>", payload)` carries the
// launcher's published manifest CID in the key suffix. Returns the bare CID
// (or empty string when the prefix is absent or malformed).
// ────────────────────────────────────────────────────────────────────────────
export const SOLVERNET_MANIFEST_PREFIX: string = "solvernet-manifest:";

export function parseSolverNetManifestKey(metadataKey: string): string {
  if (!metadataKey.startsWith(SOLVERNET_MANIFEST_PREFIX)) {
    return "";
  }
  return metadataKey.substr(SOLVERNET_MANIFEST_PREFIX.length);
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
