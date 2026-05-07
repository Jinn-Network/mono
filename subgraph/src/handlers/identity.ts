import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";

import {
  Registered as RegisteredEvent,
  MetadataSet as MetadataSetEvent,
  URIUpdated as URIUpdatedEvent,
} from "../../generated/IdentityRegistry/IdentityRegistry";

import {
  Operator,
  Execution,
  MetadataEntry,
  URIUpdate,
  SolverNetManifestEvent,
} from "../../generated/schema";

import {
  loadOrCreateOperator,
  parseMetadataKey,
  decodeExecutionPayload,
  executionId,
  executionIdFallback,
  metadataEntryId,
  parseSolverNetManifestKey,
  SOLVERNET_MANIFEST_PREFIX,
} from "../utils";

import { updateHarnessRollup } from "./harness-rollup";
import { detectFreezeViolation } from "./freeze-violation-detector";

// ────────────────────────────────────────────────────────────────────────────
// Registered(uint256 indexed agentId, string agentURI, address indexed owner)
// ────────────────────────────────────────────────────────────────────────────
export function handleRegistered(event: RegisteredEvent): void {
  let agentId = event.params.agentId;
  let owner = event.params.owner;
  let agentURI = event.params.agentURI;

  let op = loadOrCreateOperator(
    agentId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    owner as Bytes,
  );
  op.owner = owner as Bytes;
  op.agentURI = agentURI;
  op.lastUpdatedAt = event.block.timestamp;
  // First-time registration anchors registeredAt/Block/Tx; loadOrCreate
  // already filled those when creating the row.
  op.save();
}

// ────────────────────────────────────────────────────────────────────────────
// MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey,
//             string metadataKey, bytes metadataValue)
//
// We dispatch on the readable `metadataKey` parameter. The `agentWallet`
// reserved key updates Operator.agentWallet directly. Recognised execution
// kind prefixes (envelope/evaluation/intent/license) become an Execution row.
// Everything else becomes a generic MetadataEntry row.
// ────────────────────────────────────────────────────────────────────────────
export function handleMetadataSet(event: MetadataSetEvent): void {
  let agentId = event.params.agentId;
  let metadataKey = event.params.metadataKey;
  let metadataValue = event.params.metadataValue;

  let op = loadOrCreateOperator(
    agentId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    null,
  );
  op.lastUpdatedAt = event.block.timestamp;

  if (metadataKey == "agentWallet") {
    // The contract stores 20 bytes (abi.encodePacked(address)) — surface as Bytes.
    op.agentWallet = metadataValue as Bytes;
    op.save();
    return;
  }

  // SolverNet launcher manifests: `setMetadata(agentId, "solvernet-manifest:<cid>", payload)`.
  // Emit an immutable per-write event row so the operator catalog API can replay
  // history; the running `MetadataEntry` row carries the latest payload.
  if (metadataKey.startsWith(SOLVERNET_MANIFEST_PREFIX)) {
    let evtId =
      event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
    let evt = new SolverNetManifestEvent(evtId);
    evt.agentId = agentId;
    evt.operator = op.id;
    evt.metadataKey = metadataKey;
    evt.manifestCid = parseSolverNetManifestKey(metadataKey);
    evt.payload = metadataValue as Bytes;
    evt.blockNumber = event.block.number;
    evt.transactionIndex = event.transaction.index.toI32();
    evt.logIndex = event.logIndex;
    evt.timestamp = event.block.timestamp;
    evt.txHash = event.transaction.hash;
    evt.save();
    // Fall through: the catch-all branch below also persists this as a
    // generic MetadataEntry so existing consumers keep working.
  }

  // Try parsing as an execution-kind prefix.
  let parsed = parseMetadataKey(metadataKey);
  if (!parsed.recognised) {
    // Generic metadata bucket.
    let id = metadataEntryId(agentId, metadataKey);
    let entry = MetadataEntry.load(id);
    if (entry == null) {
      entry = new MetadataEntry(id);
      entry.operator = op.id;
      entry.metadataKey = metadataKey;
      entry.updateCount = 0;
    }
    entry.metadataValue = metadataValue as Bytes;
    entry.updatedAt = event.block.timestamp;
    entry.updatedBlock = event.block.number;
    entry.updatedTx = event.transaction.hash;
    entry.updateCount = entry.updateCount + 1;
    entry.save();
    op.save();
    return;
  }

  // Execution row.
  let decoded = decodeExecutionPayload(metadataValue as Bytes);

  // We prefer manifestHash-based id when payload decoded; otherwise fall back
  // to a stable hash of the metadata key so re-publishes update in place.
  let id: string;
  if (decoded.ok) {
    id = executionId(agentId, decoded.manifestHash);
  } else {
    id = executionIdFallback(agentId, metadataKey);
  }

  let exec = Execution.load(id);
  if (exec == null) {
    exec = new Execution(id);
    exec.operator = op.id;
    exec.publishCount = 0;
  }

  exec.kind = parsed.kind;
  exec.metadataKey = metadataKey;
  exec.manifestCid = parsed.cid;
  exec.payloadBytes = metadataValue as Bytes;
  exec.payloadDecoded = decoded.ok;
  exec.publishedAt = event.block.timestamp;
  exec.publishedBlock = event.block.number;
  exec.publishedTx = event.transaction.hash;
  exec.publishCount = exec.publishCount + 1;

  if (decoded.ok) {
    exec.tier = decoded.tierString;
    exec.tierRaw = decoded.tierRaw;
    exec.payloadVersion = decoded.version;
    exec.manifestHash = decoded.manifestHash;
    exec.attestationQuoteCid =
      decoded.attestationQuoteCid.length > 0 ? decoded.attestationQuoteCid : null;
    // Only persist sourceMeasurement when non-zero.
    let sm = decoded.sourceMeasurement;
    if (sm.length > 0 && !isAllZero(sm)) {
      exec.sourceMeasurement = sm;
    }
    // Index Executor.mode. v1 payloads default to "train"; v2 reads the
    // actual operator-declared value from the payload's modeFlag.
    // See docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.
    exec.mode = decoded.mode;

    // Payload v2: surface harness identity (codeDigest + implName) so the
    // HarnessRollup / FreezeViolation entities can populate. v1 payloads
    // produce empty codeDigest bytes + empty implName — leave the entity
    // fields null in that case so the rollup handlers' early-return guards
    // continue to filter them.
    if (decoded.codeDigest.length > 0 && !isAllZero(decoded.codeDigest)) {
      // Re-apply the textual `sha256:` prefix so the on-chain index matches
      // the off-chain SignedEnvelope.executor.codeDigest shape.
      exec.codeDigest = "sha256:" + decoded.codeDigest.toHexString().substr(2);
    }
    if (decoded.implName.length > 0) {
      exec.implName = decoded.implName;
    }

    // NOTE: Execution.routerJob and Execution.deliveredAt are intentionally
    // NOT populated here. The previous code compared manifestHash (an operator-
    // published keccak256 of envelope bytes) to RouterJob.id (which equals
    // JinnRouter requestId — a separate bytes32 domain). That join was
    // incorrect: the two values are from different domains and will rarely
    // match, producing silent missing or accidental links.
    //
    // These fields remain null until JinnRouter emits an event that includes
    // evidenceHash, or until ERC-8004 metadata payload v2 includes requestId
    // so the subgraph can build the join deterministically.
    // See: docs/superpowers/specs — "subgraph routerJob join gap".
  } else {
    exec.tier = "UNKNOWN";
    // Payload did not decode; default mode to "train" for back-compat.
    exec.mode = "train";
  }

  exec.save();
  op.save();

  // ── HarnessRollup aggregation ────────────────────────────────────────────
  // Called for every Execution save, but the handler short-circuits early for
  // ENVELOPE kind and for any execution where implName/codeDigest are absent
  // (all v1 payloads). EVALUATION kind with payload v2 will populate rollups.
  // FreezeViolation detection:
  // Called for ENVELOPE kind only (envelopes carry the mode + codeDigest
  // fields that drive the detector). Short-circuits early for all v1 payloads
  // because codeDigest is null until payload v2 ships. No-op until then.
  if (exec.kind == "ENVELOPE") {
    detectFreezeViolation(exec, event.block.timestamp);
  }

  if (exec.kind == "EVALUATION") {
    updateHarnessRollup(exec, event.block.timestamp, op.id);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)
// ────────────────────────────────────────────────────────────────────────────
export function handleURIUpdated(event: URIUpdatedEvent): void {
  let agentId = event.params.agentId;
  let newURI = event.params.newURI;

  let op = loadOrCreateOperator(
    agentId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    null,
  );
  op.agentURI = newURI;
  op.lastUpdatedAt = event.block.timestamp;
  op.save();

  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let row = new URIUpdate(id);
  row.operator = op.id;
  row.newURI = newURI;
  row.updatedBy = event.params.updatedBy as Bytes;
  row.updatedAt = event.block.timestamp;
  row.updatedBlock = event.block.number;
  row.updatedTx = event.transaction.hash;
  row.save();
}

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────
function isAllZero(b: Bytes): bool {
  for (let i = 0; i < b.length; i++) {
    if (b[i] != 0) return false;
  }
  return true;
}
