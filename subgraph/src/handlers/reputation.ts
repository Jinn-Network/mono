import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";

import {
  NewFeedback as NewFeedbackEvent,
  FeedbackRevoked as FeedbackRevokedEvent,
  ResponseAppended as ResponseAppendedEvent,
} from "../../generated/ReputationRegistry/ReputationRegistry";

import {
  Feedback,
  FeedbackResponse,
  Operator,
  Execution,
} from "../../generated/schema";

import { loadOrCreateOperator, parseManifestRef } from "../utils";

function feedbackId(
  agentId: BigInt,
  client: Bytes,
  feedbackIndex: BigInt,
): string {
  return (
    agentId.toString() + "-" + client.toHexString() + "-" + feedbackIndex.toString()
  );
}

// ────────────────────────────────────────────────────────────────────────────
// NewFeedback(uint256 indexed agentId,
//             address indexed clientAddress,
//             uint64 feedbackIndex,
//             int128 value, uint8 valueDecimals,
//             string indexed indexedTag1,
//             string tag1, string tag2,
//             string endpoint, string feedbackURI, bytes32 feedbackHash)
// ────────────────────────────────────────────────────────────────────────────
export function handleNewFeedback(event: NewFeedbackEvent): void {
  let agentId = event.params.agentId;
  let client = event.params.clientAddress;
  let feedbackIndex = event.params.feedbackIndex;

  let op = loadOrCreateOperator(
    agentId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    null,
  );
  op.lastUpdatedAt = event.block.timestamp;
  op.save();

  let id = feedbackId(agentId, client as Bytes, feedbackIndex);
  let row = Feedback.load(id);
  if (row == null) {
    row = new Feedback(id);
  }
  row.agent = op.id;
  row.client = client as Bytes;
  row.feedbackIndex = feedbackIndex;
  row.value = event.params.value;
  row.valueDecimals = event.params.valueDecimals as i32;
  row.tag1 = event.params.tag1;
  row.tag2 = event.params.tag2;
  row.endpoint = event.params.endpoint;
  row.feedbackURI = event.params.feedbackURI;
  row.feedbackHash = event.params.feedbackHash as Bytes;

  let manifestRef = parseManifestRef(event.params.feedbackURI, event.params.tag2);
  if (manifestRef !== null) {
    row.manifestRef = manifestRef;

    // Best-effort link to Execution: try `<agentId>-<manifestHash hex>` shape
    // by hashing the parsed CID. We don't know the manifestHash here without
    // a lookup, so we just leave .execution unset; consumers can join on
    // `manifestRef == Execution.manifestCid` at query time.
    //
    // If the manifestRef happens to be a 0x-prefixed bytes32, treat it as a
    // direct manifestHash and try to load the matching Execution.
    if (manifestRef.startsWith("0x") && manifestRef.length == 66) {
      let execId = agentId.toString() + "-" + manifestRef;
      let exec = Execution.load(execId);
      if (exec !== null) {
        row.execution = exec.id;
      }
    }
  }

  row.revoked = false;
  row.createdAt = event.block.timestamp;
  row.createdBlock = event.block.number;
  row.createdTx = event.transaction.hash;
  row.save();
}

// ────────────────────────────────────────────────────────────────────────────
// FeedbackRevoked(uint256 indexed agentId,
//                 address indexed clientAddress,
//                 uint64 indexed feedbackIndex)
// ────────────────────────────────────────────────────────────────────────────
export function handleFeedbackRevoked(event: FeedbackRevokedEvent): void {
  let agentId = event.params.agentId;
  let client = event.params.clientAddress;
  let feedbackIndex = event.params.feedbackIndex;

  let id = feedbackId(agentId, client as Bytes, feedbackIndex);
  let row = Feedback.load(id);
  if (row == null) {
    log.warning("FeedbackRevoked for unknown feedback {}", [id]);
    return;
  }
  row.revoked = true;
  row.revokedAt = event.block.timestamp;
  row.revokedTx = event.transaction.hash;
  row.save();
}

// ────────────────────────────────────────────────────────────────────────────
// ResponseAppended(uint256 indexed agentId,
//                  address indexed clientAddress,
//                  uint64 feedbackIndex,
//                  address indexed responder,
//                  string responseURI, bytes32 responseHash)
// ────────────────────────────────────────────────────────────────────────────
export function handleResponseAppended(event: ResponseAppendedEvent): void {
  let agentId = event.params.agentId;
  let client = event.params.clientAddress;
  let feedbackIndex = event.params.feedbackIndex;

  let parentId = feedbackId(agentId, client as Bytes, feedbackIndex);
  let parent = Feedback.load(parentId);
  if (parent == null) {
    log.warning("ResponseAppended for unknown feedback {}", [parentId]);
    return;
  }

  let id =
    parentId +
    "-" +
    (event.params.responder as Bytes).toHexString() +
    "-" +
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let row = new FeedbackResponse(id);
  row.feedback = parent.id;
  row.responder = event.params.responder as Bytes;
  row.responseURI = event.params.responseURI;
  row.responseHash = event.params.responseHash as Bytes;
  row.appendedAt = event.block.timestamp;
  row.appendedBlock = event.block.number;
  row.appendedTx = event.transaction.hash;
  row.save();
}
