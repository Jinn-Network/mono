import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";

import {
  ValidationRequest as ValidationRequestEvent,
  ValidationResponse as ValidationResponseEvent,
} from "../../generated/ValidationRegistry/ValidationRegistry";

import { Validation, Execution, Operator } from "../../generated/schema";

import { loadOrCreateOperator, executionId } from "../utils";

// ────────────────────────────────────────────────────────────────────────────
// ValidationRequest(address indexed validatorAddress,
//                   uint256 indexed agentId,
//                   string requestURI,
//                   bytes32 indexed requestHash)
//
// `requestHash` is keyed by the contract; the DR (§4.4) treats it as
// `manifest.evidenceHash`. We use the requestHash hex as the entity id so
// challenger replays land idempotently. (Contract enforces uniqueness.)
// ────────────────────────────────────────────────────────────────────────────
export function handleValidationRequest(event: ValidationRequestEvent): void {
  let agentId = event.params.agentId;
  let validator = event.params.validatorAddress;
  let requestHash = event.params.requestHash;
  let requestURI = event.params.requestURI;

  let op = loadOrCreateOperator(
    agentId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    null,
  );
  op.lastUpdatedAt = event.block.timestamp;
  op.save();

  let id = requestHash.toHexString();
  let row = Validation.load(id);
  if (row == null) {
    row = new Validation(id);
  }
  row.agent = op.id;
  row.validator = validator as Bytes;
  row.requestHash = requestHash as Bytes;
  row.requestURI = requestURI;
  row.status = "REQUESTED";
  row.requestedAt = event.block.timestamp;
  row.requestedBlock = event.block.number;
  row.requestedTx = event.transaction.hash;

  // Try linking to an Execution row by manifestHash == requestHash on the same
  // agentId. If the operator has published an envelope with that manifestHash,
  // its Execution id is `<agentId>-<manifestHash>` (see utils.executionId).
  let execId = executionId(agentId, requestHash as Bytes);
  let exec = Execution.load(execId);
  if (exec !== null) {
    row.execution = exec.id;
  }

  row.save();
}

// ────────────────────────────────────────────────────────────────────────────
// ValidationResponse(address indexed validatorAddress,
//                    uint256 indexed agentId,
//                    bytes32 indexed requestHash,
//                    uint8 response,
//                    string responseURI,
//                    bytes32 responseHash,
//                    string tag)
// ────────────────────────────────────────────────────────────────────────────
export function handleValidationResponse(event: ValidationResponseEvent): void {
  let requestHash = event.params.requestHash;
  let id = requestHash.toHexString();
  let row = Validation.load(id);
  if (row == null) {
    // Should not happen — the contract requires the request to exist before
    // a response can be filed. Log and skip.
    log.warning("ValidationResponse for unknown requestHash {}", [id]);
    return;
  }
  row.status = "RESPONDED";
  row.response = event.params.response as i32;
  row.responseURI = event.params.responseURI;
  row.responseHash = event.params.responseHash as Bytes;
  row.tag = event.params.tag;
  row.respondedAt = event.block.timestamp;
  row.respondedBlock = event.block.number;
  row.respondedTx = event.transaction.hash;
  row.save();
}
