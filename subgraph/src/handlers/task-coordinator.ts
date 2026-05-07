import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";

import {
  TaskCreated as TaskCreatedEvent,
  TaskClaimed as TaskClaimedEvent,
  TaskAttemptRequestRegistered as TaskAttemptRequestRegisteredEvent,
  TaskSubmitted as TaskSubmittedEvent,
  EvaluationClaimed as EvaluationClaimedEvent,
  VerdictRequestRegistered as VerdictRequestRegisteredEvent,
  VerdictDelivered as VerdictDeliveredEvent,
  AttemptFinalized as AttemptFinalizedEvent,
  TaskCreationCreditLocked as TaskCreationCreditLockedEvent,
  TaskAttemptExpired as TaskAttemptExpiredEvent,
} from "../../generated/TaskCoordinator/TaskCoordinator";

import { Task, TaskAttempt, Verdict } from "../../generated/schema";

import { taskId, taskAttemptId, verdictId } from "../utils";

// ────────────────────────────────────────────────────────────────────────────
// Helpers — load-or-create stubs so events arriving out of order still create
// a row. The router-side handler fills in budget fields from its own
// TaskCreated; the coordinator emits the manifest digests.
//
// uint32 attemptIndex / verdictIndex come back as BigInt from graph-ts (the
// indexed-or-not detail doesn't matter — non-indexed numeric scalars > 32 bits
// also decode to BigInt). Schema fields are Int (i32), so we convert at the
// boundary with `.toI32()`.
// ────────────────────────────────────────────────────────────────────────────
function loadOrCreateTask(
  taskIdValue: BigInt,
  blockTimestamp: BigInt,
  blockNumber: BigInt,
  txHash: Bytes,
): Task {
  let id = taskId(taskIdValue);
  let row = Task.load(id);
  if (row == null) {
    row = new Task(id);
    row.taskId = taskIdValue;
    row.creator = Bytes.empty();
    row.manifestDigest = Bytes.empty();
    row.taskCidDigest = Bytes.empty();
    row.finalized = false;
    row.refunded = false;
    row.createdAt = blockTimestamp;
    row.createdAtBlock = blockNumber;
    row.createdAtTx = txHash;
  }
  return row as Task;
}

function loadOrCreateAttempt(
  taskIdValue: BigInt,
  attemptIndex: BigInt,
  operator: Bytes,
  blockNumber: BigInt,
  txHash: Bytes,
): TaskAttempt {
  let id = taskAttemptId(taskIdValue, attemptIndex);
  let row = TaskAttempt.load(id);
  if (row == null) {
    let task = Task.load(taskId(taskIdValue));
    if (task == null) {
      // Partial backfill window — TaskCoordinator.TaskCreated should land
      // first in normal flow but we still tolerate the inverse.
      task = new Task(taskId(taskIdValue));
      task.taskId = taskIdValue;
      task.creator = Bytes.empty();
      task.manifestDigest = Bytes.empty();
      task.taskCidDigest = Bytes.empty();
      task.finalized = false;
      task.refunded = false;
      task.createdAt = BigInt.zero();
      task.createdAtBlock = blockNumber;
      task.createdAtTx = txHash;
      task.save();
    }
    row = new TaskAttempt(id);
    row.task = task.id;
    row.attemptIndex = attemptIndex.toI32();
    row.operator = operator;
    row.status = "CLAIMED";
    row.finalized = false;
    row.claimedAtBlock = blockNumber;
    row.claimedAtTx = txHash;
  }
  return row as TaskAttempt;
}

function loadOrCreateVerdict(
  taskIdValue: BigInt,
  attemptIndex: BigInt,
  verdictIndex: BigInt,
  evaluator: Bytes,
  blockNumber: BigInt,
  txHash: Bytes,
): Verdict {
  let id = verdictId(taskIdValue, attemptIndex, verdictIndex);
  let row = Verdict.load(id);
  if (row == null) {
    let attempt = TaskAttempt.load(taskAttemptId(taskIdValue, attemptIndex));
    if (attempt == null) {
      attempt = loadOrCreateAttempt(
        taskIdValue,
        attemptIndex,
        Bytes.empty(),
        blockNumber,
        txHash,
      );
      attempt.save();
    }
    row = new Verdict(id);
    row.attempt = attempt.id;
    row.verdictIndex = verdictIndex.toI32();
    row.evaluator = evaluator;
    row.status = "CLAIMED";
    row.claimedAtBlock = blockNumber;
    row.claimedAtTx = txHash;
  }
  return row as Verdict;
}

// ────────────────────────────────────────────────────────────────────────────
// TaskCoordinator events
// ────────────────────────────────────────────────────────────────────────────

export function handleTaskCreated(event: TaskCreatedEvent): void {
  let row = loadOrCreateTask(
    event.params.taskId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
  );
  row.creator = event.params.creator as Bytes;
  row.manifestDigest = event.params.manifestDigest as Bytes;
  row.taskCidDigest = event.params.taskCidDigest as Bytes;
  row.maxClaims = event.params.maxClaims;
  row.requiredVerdicts = event.params.requiredVerdicts;
  row.claimWindowStart = event.params.claimWindowStart;
  row.claimWindowEnd = event.params.claimWindowEnd;
  row.submissionDeadline = event.params.submissionDeadline;
  row.evaluationDeadline = event.params.evaluationDeadline;
  // Anchor canonical createdAt/Tx on the coordinator emission (the coordinator
  // carries the manifest digests; the router emits a paired event with budgets).
  row.createdAt = event.block.timestamp;
  row.createdAtBlock = event.block.number;
  row.createdAtTx = event.transaction.hash;
  row.save();
}

export function handleTaskClaimed(event: TaskClaimedEvent): void {
  let row = loadOrCreateAttempt(
    event.params.taskId,
    event.params.attemptIndex,
    event.params.operator as Bytes,
    event.block.number,
    event.transaction.hash,
  );
  row.operator = event.params.operator as Bytes;
  row.status = "CLAIMED";
  row.claimExpiresAt = event.params.claimExpiresAt;
  row.claimedAtBlock = event.block.number;
  row.claimedAtTx = event.transaction.hash;
  row.save();
}

export function handleTaskAttemptRequestRegistered(
  event: TaskAttemptRequestRegisteredEvent,
): void {
  let row = loadOrCreateAttempt(
    event.params.taskId,
    event.params.attemptIndex,
    Bytes.empty(),
    event.block.number,
    event.transaction.hash,
  );
  row.solutionRequestId = event.params.requestId as Bytes;
  row.save();
}

export function handleTaskSubmitted(event: TaskSubmittedEvent): void {
  let row = loadOrCreateAttempt(
    event.params.taskId,
    event.params.attemptIndex,
    event.params.operator as Bytes,
    event.block.number,
    event.transaction.hash,
  );
  row.operator = event.params.operator as Bytes;
  row.solutionRequestId = event.params.requestId as Bytes;
  row.solutionCidDigest = event.params.solutionCidDigest as Bytes;
  row.solutionWeight = event.params.solutionWeight;
  row.submittedAt = event.block.timestamp;
  row.submittedAtBlock = event.block.number;
  row.submittedAtTx = event.transaction.hash;
  if (row.status == "CLAIMED") {
    row.status = "SUBMITTED";
  }
  row.save();
}

export function handleEvaluationClaimed(event: EvaluationClaimedEvent): void {
  let row = loadOrCreateVerdict(
    event.params.taskId,
    event.params.attemptIndex,
    event.params.verdictIndex,
    event.params.evaluator as Bytes,
    event.block.number,
    event.transaction.hash,
  );
  row.evaluator = event.params.evaluator as Bytes;
  row.status = "CLAIMED";
  row.claimExpiresAt = event.params.claimExpiresAt;
  row.claimedAtBlock = event.block.number;
  row.claimedAtTx = event.transaction.hash;
  row.save();
}

export function handleVerdictRequestRegistered(
  event: VerdictRequestRegisteredEvent,
): void {
  let row = loadOrCreateVerdict(
    event.params.taskId,
    event.params.attemptIndex,
    event.params.verdictIndex,
    Bytes.empty(),
    event.block.number,
    event.transaction.hash,
  );
  row.verdictRequestId = event.params.requestId as Bytes;
  row.save();
}

export function handleVerdictDelivered(event: VerdictDeliveredEvent): void {
  let row = loadOrCreateVerdict(
    event.params.taskId,
    event.params.attemptIndex,
    event.params.verdictIndex,
    event.params.evaluator as Bytes,
    event.block.number,
    event.transaction.hash,
  );
  row.evaluator = event.params.evaluator as Bytes;
  row.status = "DELIVERED";
  row.verdictCidDigest = event.params.verdictCidDigest as Bytes;
  row.verdictCode = event.params.verdictCode;
  row.deliveredAt = event.block.timestamp;
  row.deliveredAtBlock = event.block.number;
  row.deliveredAtTx = event.transaction.hash;
  row.save();
}

export function handleAttemptFinalized(event: AttemptFinalizedEvent): void {
  let row = loadOrCreateAttempt(
    event.params.taskId,
    event.params.attemptIndex,
    Bytes.empty(),
    event.block.number,
    event.transaction.hash,
  );
  row.status = "FINALIZED";
  row.finalized = true;
  row.passed = event.params.passed;
  row.validVerdictCount = event.params.validVerdictCount;
  row.passVerdictCount = event.params.passVerdictCount;
  row.finalizedAt = event.block.timestamp;
  row.finalizedAtBlock = event.block.number;
  row.finalizedAtTx = event.transaction.hash;
  row.save();

  if (event.params.passed) {
    let task = Task.load(taskId(event.params.taskId));
    if (task != null) {
      task.finalized = true;
      task.save();
    }
  }
}

export function handleTaskCreationCreditLocked(
  event: TaskCreationCreditLockedEvent,
): void {
  // Best-effort: ensure the Task row exists even if events arrive out of order.
  // Credit weight is not surfaced directly today; the router-side budgets
  // capture the JINN amounts.
  let row = loadOrCreateTask(
    event.params.taskId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
  );
  if (row.creator.length == 0) {
    row.creator = event.params.creator as Bytes;
  }
  row.save();
}

export function handleTaskAttemptExpired(event: TaskAttemptExpiredEvent): void {
  let row = loadOrCreateAttempt(
    event.params.taskId,
    event.params.attemptIndex,
    event.params.operator as Bytes,
    event.block.number,
    event.transaction.hash,
  );
  row.status = "EXPIRED";
  row.expiredAt = event.block.timestamp;
  row.expiredAtTx = event.transaction.hash;
  row.save();
}
