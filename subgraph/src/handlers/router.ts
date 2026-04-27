import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";

import {
  RestorationJobCreated as RestorationJobCreatedEvent,
  EvaluationJobCreated as EvaluationJobCreatedEvent,
  DeliveryClaimed as DeliveryClaimedEvent,
} from "../../generated/JinnRouter/JinnRouter";

import { RouterJob, Execution } from "../../generated/schema";

import { routerJobId } from "../utils";

// ────────────────────────────────────────────────────────────────────────────
// RestorationJobCreated(address indexed creator, bytes32 indexed requestId)
// ────────────────────────────────────────────────────────────────────────────
export function handleRestorationJobCreated(event: RestorationJobCreatedEvent): void {
  let id = routerJobId(event.params.requestId as Bytes);
  let row = RouterJob.load(id);
  if (row == null) {
    row = new RouterJob(id);
  }
  row.kind = "RESTORATION";
  row.creator = event.params.creator as Bytes;
  row.createdAt = event.block.timestamp;
  row.createdBlock = event.block.number;
  row.createdTx = event.transaction.hash;
  row.save();
}

// ────────────────────────────────────────────────────────────────────────────
// EvaluationJobCreated(address indexed creator,
//                      bytes32 indexed requestId,
//                      bytes32 indexed restorationRequestId)
// ────────────────────────────────────────────────────────────────────────────
export function handleEvaluationJobCreated(event: EvaluationJobCreatedEvent): void {
  let id = routerJobId(event.params.requestId as Bytes);
  let row = RouterJob.load(id);
  if (row == null) {
    row = new RouterJob(id);
  }
  row.kind = "EVALUATION";
  row.creator = event.params.creator as Bytes;
  row.restorationRequestId = event.params.restorationRequestId as Bytes;
  row.createdAt = event.block.timestamp;
  row.createdBlock = event.block.number;
  row.createdTx = event.transaction.hash;

  // Link to parent restoration job if we already saw it.
  let parentId = routerJobId(event.params.restorationRequestId as Bytes);
  let parent = RouterJob.load(parentId);
  if (parent !== null) {
    row.parentJob = parent.id;
  }
  row.save();
}

// ────────────────────────────────────────────────────────────────────────────
// DeliveryClaimed(address indexed claimer, bytes32 indexed requestId, uint8 jobType)
//
// Phase 1b's V2 `claimDelivery(bytes32, bytes32)` has a second arg
// (`evidenceHash`) on the function but the **event signature is unchanged**
// (claimer, requestId, jobType) — the evidence hash is accepted by the
// contract but not emitted by this event. Per the DR (§4.4) the
// `evidenceHash` becomes the `requestHash` argument to ValidationRegistry,
// which we already index.
// ────────────────────────────────────────────────────────────────────────────
export function handleDeliveryClaimed(event: DeliveryClaimedEvent): void {
  let id = routerJobId(event.params.requestId as Bytes);
  let row = RouterJob.load(id);
  if (row == null) {
    // We saw a claim before the create event (reorg / fresh deployment with a
    // partial backfill window). Create a placeholder row.
    row = new RouterJob(id);
    row.kind = "RESTORATION"; // best guess; will be overwritten if create arrives
    row.creator = Bytes.empty();
    row.createdAt = event.block.timestamp;
    row.createdBlock = event.block.number;
    row.createdTx = event.transaction.hash;
  }
  row.deliveryJobType = event.params.jobType as i32;
  row.claimer = event.params.claimer as Bytes;
  row.claimedAt = event.block.timestamp;
  row.claimedBlock = event.block.number;
  row.claimedTx = event.transaction.hash;
  row.save();

  // If an Execution row already names this requestId, propagate deliveredAt.
  // The Execution↔Router join is best-effort; canonical truth lives in the
  // operator-published metadata payload (`manifestHash`).
}
