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
  RouterJob,
} from "../../generated/schema";

import {
  loadOrCreateOperator,
  parseMetadataKey,
  decodeExecutionPayload,
  executionId,
  executionIdFallback,
  metadataEntryId,
  routerJobId,
} from "../utils";

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

    // Best-effort RouterJob join: if a RouterJob with id == manifestHash hex
    // exists, link it. (The router emits requestId == bytes32; the manifest
    // hash is published by the operator independently. They may or may not
    // match — see DR §4.4.)
    let jobId = routerJobId(decoded.manifestHash);
    let job = RouterJob.load(jobId);
    if (job !== null) {
      exec.jinnRouterRequestId = decoded.manifestHash;
      exec.routerJob = job.id;
      if (job.claimedAt !== null) {
        exec.deliveredAt = job.claimedAt;
      }
    }
  } else {
    exec.tier = "UNKNOWN";
  }

  exec.save();
  op.save();
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
