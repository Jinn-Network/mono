import { log } from "@graphprotocol/graph-ts";
import {
  ValidationRequested,
  ValidationResponded,
} from "../../generated/ValidationRegistry/ValidationRegistry";
import {
  ValidationRequest,
  ValidationResponse,
  ExecutionEnvelope,
} from "../../generated/schema";

export function handleValidationRequestedImpl(event: ValidationRequested): void {
  // event.params.envelopeCid is an indexed bytes32 from the ABI
  const envelopeId = event.params.envelopeCid.toHexString();
  const env = ExecutionEnvelope.load(envelopeId);
  if (env == null) {
    log.warning("ValidationRequested for unknown envelope {} — skipping", [envelopeId]);
    return;
  }

  const requestId = event.params.requestId.toHexString();
  const req = new ValidationRequest(requestId);
  req.envelope = envelopeId;
  req.challenger = event.params.challenger;
  req.scope = event.params.scope;
  req.requestedAt = event.block.timestamp;
  req.createdAtBlock = event.block.number;
  req.createdAtTx = event.transaction.hash;
  req.save();
}

export function handleValidationRespondedImpl(event: ValidationResponded): void {
  const reqId = event.params.requestId.toHexString();
  const req = ValidationRequest.load(reqId);
  if (req == null) {
    log.warning("ValidationResponded without matching request {} — skipping", [reqId]);
    return;
  }

  const responseId = event.params.responseId.toHexString();
  const resp = new ValidationResponse(responseId);
  resp.request = reqId;
  resp.envelope = req.envelope;
  resp.validator = event.params.validator;
  resp.overall = event.params.overall;
  resp.detail = event.params.detail;
  resp.respondedAt = event.block.timestamp;
  resp.createdAtBlock = event.block.number;
  resp.createdAtTx = event.transaction.hash;
  resp.save();

  req.response = responseId;
  req.save();
}
