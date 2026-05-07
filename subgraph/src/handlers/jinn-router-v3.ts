import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";

import {
  TaskCreated as RouterTaskCreatedEvent,
  TaskAttemptCreated as TaskAttemptCreatedEvent,
  EvaluationAttemptCreated as EvaluationAttemptCreatedEvent,
  SolutionDeliveryClaimed as SolutionDeliveryClaimedEvent,
  VerdictDeliveryClaimed as VerdictDeliveryClaimedEvent,
  TaskBudgetRefunded as TaskBudgetRefundedEvent,
} from "../../generated/JinnRouterV3/JinnRouterV3";

import { Task, TaskAttempt, Verdict } from "../../generated/schema";

import { taskId, taskAttemptId, verdictId } from "../utils";

// ────────────────────────────────────────────────────────────────────────────
// JinnRouterV3 emits paired events alongside TaskCoordinator; we use these
// to fill in budget + requestId fields the coordinator doesn't surface.
// Every handler is load-or-create against the same composite ids the
// TaskCoordinator handler uses, so events arriving in either order converge
// on a single canonical row.
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
// Router events
// ────────────────────────────────────────────────────────────────────────────

export function handleRouterTaskCreated(event: RouterTaskCreatedEvent): void {
  let row = loadOrCreateTask(
    event.params.taskId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
  );
  // Backfill creator + manifest fields if the coordinator emission hasn't
  // arrived yet (in normal flow it lands first).
  if (row.creator.length == 0) {
    row.creator = event.params.creator as Bytes;
  }
  if (row.manifestDigest.length == 0) {
    row.manifestDigest = event.params.manifestDigest as Bytes;
  }
  if (row.taskCidDigest.length == 0) {
    row.taskCidDigest = event.params.taskCidDigest as Bytes;
  }
  // maxClaims / requiredVerdicts are emitted by both the router and the
  // coordinator with the same values; either ordering converges.
  row.maxClaims = event.params.maxClaims;
  row.requiredVerdicts = event.params.requiredVerdicts;
  row.solutionBudget = event.params.solutionBudget;
  row.verdictBudget = event.params.verdictBudget;
  row.save();
}

export function handleTaskAttemptCreated(event: TaskAttemptCreatedEvent): void {
  let row = loadOrCreateAttempt(
    event.params.taskId,
    event.params.attemptIndex,
    event.params.operator as Bytes,
    event.block.number,
    event.transaction.hash,
  );
  row.operator = event.params.operator as Bytes;
  row.solutionRequestId = event.params.requestId as Bytes;
  row.save();
}

export function handleEvaluationAttemptCreated(
  event: EvaluationAttemptCreatedEvent,
): void {
  let row = loadOrCreateVerdict(
    event.params.taskId,
    event.params.attemptIndex,
    event.params.verdictIndex,
    event.params.evaluator as Bytes,
    event.block.number,
    event.transaction.hash,
  );
  row.evaluator = event.params.evaluator as Bytes;
  row.verdictRequestId = event.params.requestId as Bytes;
  row.save();
}

export function handleSolutionDeliveryClaimed(
  event: SolutionDeliveryClaimedEvent,
): void {
  // Marker that the operator claimed router-side delivery rewards. The
  // canonical submission state lives on TaskCoordinator.TaskSubmitted —
  // we ensure the row exists so reverse joins don't 404.
  let row = loadOrCreateAttempt(
    event.params.taskId,
    event.params.attemptIndex,
    event.params.operator as Bytes,
    event.block.number,
    event.transaction.hash,
  );
  if (row.solutionRequestId === null) {
    row.solutionRequestId = event.params.requestId as Bytes;
  }
  row.save();
}

export function handleVerdictDeliveryClaimed(
  event: VerdictDeliveryClaimedEvent,
): void {
  let row = loadOrCreateVerdict(
    event.params.taskId,
    event.params.attemptIndex,
    event.params.verdictIndex,
    event.params.evaluator as Bytes,
    event.block.number,
    event.transaction.hash,
  );
  if (row.verdictRequestId === null) {
    row.verdictRequestId = event.params.requestId as Bytes;
  }
  // Router-side mirror of verdictCode; the canonical value comes from
  // TaskCoordinator.VerdictDelivered, which is the only event that flips
  // status to DELIVERED. We only set verdictCode here when the row is still
  // in the CLAIMED state (no coordinator delivery yet).
  if (row.status == "CLAIMED") {
    row.verdictCode = event.params.verdictCode;
  }
  row.save();
}

export function handleTaskBudgetRefunded(event: TaskBudgetRefundedEvent): void {
  let row = loadOrCreateTask(
    event.params.taskId,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
  );
  row.refunded = true;
  row.refundedSolutionAmount = event.params.solutionAmount;
  row.refundedVerdictAmount = event.params.verdictAmount;
  if (row.creator.length == 0) {
    row.creator = event.params.creator as Bytes;
  }
  row.save();
}
