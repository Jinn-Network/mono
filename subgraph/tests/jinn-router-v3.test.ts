import {
  assert,
  describe,
  test,
  clearStore,
  newMockEvent,
  beforeEach,
} from "matchstick-as/assembly";
import {
  Address,
  BigInt,
  Bytes,
  ethereum,
} from "@graphprotocol/graph-ts";

import {
  handleRouterTaskCreated,
  handleTaskAttemptCreated,
  handleEvaluationAttemptCreated,
  handleSolutionDeliveryClaimed,
  handleVerdictDeliveryClaimed,
  handleTaskBudgetRefunded,
} from "../src/handlers/jinn-router-v3";
import {
  TaskCreated as RouterTaskCreated,
  TaskAttemptCreated,
  EvaluationAttemptCreated,
  SolutionDeliveryClaimed,
  VerdictDeliveryClaimed,
  TaskBudgetRefunded,
} from "../generated/JinnRouterV3/JinnRouterV3";
// In normal indexing flow the TaskCoordinator emission lands first; we mirror
// that so the router-side handler exercises its load-or-create + guard paths.
import { handleTaskCreated as handleCoordinatorTaskCreated } from "../src/handlers/task-coordinator";
import { TaskCreated as CoordinatorTaskCreated } from "../generated/TaskCoordinator/TaskCoordinator";

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────
const CREATOR_HEX = "0x1234567890123456789012345678901234567890";
const OPERATOR_HEX = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const EVALUATOR_HEX = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed";
const PRIORITY_MECH_HEX = "0x000000000000000000000000000000000000beef";
const MANIFEST_DIGEST_HEX =
  "0xabababababababababababababababababababababababababababababababab";
const TASK_CID_DIGEST_HEX =
  "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const SOLUTION_REQUEST_ID_HEX =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const VERDICT_REQUEST_ID_HEX =
  "0x3333333333333333333333333333333333333333333333333333333333333333";

// ────────────────────────────────────────────────────────────────────────────
// Coordinator-side seeder (mirrors normal event ordering).
// ────────────────────────────────────────────────────────────────────────────
function seedCoordinatorTask(
  taskIdValue: BigInt,
  creator: Address,
  manifestDigest: Bytes,
  taskCidDigest: Bytes,
): void {
  let event = changetype<CoordinatorTaskCreated>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam(
      "taskId",
      ethereum.Value.fromUnsignedBigInt(taskIdValue),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("creator", ethereum.Value.fromAddress(creator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "manifestDigest",
      ethereum.Value.fromFixedBytes(manifestDigest),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "taskCidDigest",
      ethereum.Value.fromFixedBytes(taskCidDigest),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "maxClaims",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(3)),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "requiredVerdicts",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "claimWindowStart",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1700000000)),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "claimWindowEnd",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1700003600)),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "submissionDeadline",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1700007200)),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "evaluationDeadline",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1700010800)),
    ),
  );
  handleCoordinatorTaskCreated(event);
}

// ────────────────────────────────────────────────────────────────────────────
// Event builders — match the JinnRouterV3 ABI param order exactly.
// ────────────────────────────────────────────────────────────────────────────
function buildRouterTaskCreatedEvent(
  creator: Address,
  taskId: BigInt,
  manifestDigest: Bytes,
  taskCidDigest: Bytes,
  maxClaims: i32,
  requiredVerdicts: i32,
  solutionBudget: BigInt,
  verdictBudget: BigInt,
): RouterTaskCreated {
  let event = changetype<RouterTaskCreated>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("creator", ethereum.Value.fromAddress(creator)),
  );
  event.parameters.push(
    new ethereum.EventParam("taskId", ethereum.Value.fromUnsignedBigInt(taskId)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "manifestDigest",
      ethereum.Value.fromFixedBytes(manifestDigest),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "taskCidDigest",
      ethereum.Value.fromFixedBytes(taskCidDigest),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "maxClaims",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(maxClaims)),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "requiredVerdicts",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(requiredVerdicts)),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "solutionBudget",
      ethereum.Value.fromUnsignedBigInt(solutionBudget),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "verdictBudget",
      ethereum.Value.fromUnsignedBigInt(verdictBudget),
    ),
  );
  return event;
}

function buildTaskAttemptCreatedEvent(
  taskId: BigInt,
  attemptIndex: BigInt,
  requestId: Bytes,
  operator: Address,
  priorityMech: Address,
  deliveryRate: BigInt,
): TaskAttemptCreated {
  let event = changetype<TaskAttemptCreated>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("taskId", ethereum.Value.fromUnsignedBigInt(taskId)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "attemptIndex",
      ethereum.Value.fromUnsignedBigInt(attemptIndex),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "requestId",
      ethereum.Value.fromFixedBytes(requestId),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("operator", ethereum.Value.fromAddress(operator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "priorityMech",
      ethereum.Value.fromAddress(priorityMech),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "deliveryRate",
      ethereum.Value.fromUnsignedBigInt(deliveryRate),
    ),
  );
  return event;
}

function buildEvaluationAttemptCreatedEvent(
  taskId: BigInt,
  attemptIndex: BigInt,
  verdictIndex: BigInt,
  requestId: Bytes,
  evaluator: Address,
  priorityMech: Address,
  deliveryRate: BigInt,
): EvaluationAttemptCreated {
  let event = changetype<EvaluationAttemptCreated>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("taskId", ethereum.Value.fromUnsignedBigInt(taskId)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "attemptIndex",
      ethereum.Value.fromUnsignedBigInt(attemptIndex),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "verdictIndex",
      ethereum.Value.fromUnsignedBigInt(verdictIndex),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "requestId",
      ethereum.Value.fromFixedBytes(requestId),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("evaluator", ethereum.Value.fromAddress(evaluator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "priorityMech",
      ethereum.Value.fromAddress(priorityMech),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "deliveryRate",
      ethereum.Value.fromUnsignedBigInt(deliveryRate),
    ),
  );
  return event;
}

function buildSolutionDeliveryClaimedEvent(
  operator: Address,
  requestId: Bytes,
  taskId: BigInt,
  attemptIndex: BigInt,
): SolutionDeliveryClaimed {
  let event = changetype<SolutionDeliveryClaimed>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("operator", ethereum.Value.fromAddress(operator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "requestId",
      ethereum.Value.fromFixedBytes(requestId),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("taskId", ethereum.Value.fromUnsignedBigInt(taskId)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "attemptIndex",
      ethereum.Value.fromUnsignedBigInt(attemptIndex),
    ),
  );
  return event;
}

function buildVerdictDeliveryClaimedEvent(
  evaluator: Address,
  requestId: Bytes,
  taskId: BigInt,
  attemptIndex: BigInt,
  verdictIndex: BigInt,
  verdictCode: i32,
): VerdictDeliveryClaimed {
  let event = changetype<VerdictDeliveryClaimed>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("evaluator", ethereum.Value.fromAddress(evaluator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "requestId",
      ethereum.Value.fromFixedBytes(requestId),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("taskId", ethereum.Value.fromUnsignedBigInt(taskId)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "attemptIndex",
      ethereum.Value.fromUnsignedBigInt(attemptIndex),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "verdictIndex",
      ethereum.Value.fromUnsignedBigInt(verdictIndex),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "verdictCode",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(verdictCode)),
    ),
  );
  return event;
}

function buildTaskBudgetRefundedEvent(
  taskId: BigInt,
  creator: Address,
  solutionAmount: BigInt,
  verdictAmount: BigInt,
): TaskBudgetRefunded {
  let event = changetype<TaskBudgetRefunded>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("taskId", ethereum.Value.fromUnsignedBigInt(taskId)),
  );
  event.parameters.push(
    new ethereum.EventParam("creator", ethereum.Value.fromAddress(creator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "solutionAmount",
      ethereum.Value.fromUnsignedBigInt(solutionAmount),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "verdictAmount",
      ethereum.Value.fromUnsignedBigInt(verdictAmount),
    ),
  );
  return event;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────
describe("JinnRouterV3 handlers", () => {
  beforeEach(() => {
    clearStore();
  });

  test(
    "handleRouterTaskCreated populates budgets + maxClaims after coordinator seed",
    () => {
      // Normal flow: coordinator emits TaskCreated first (carrying creator +
      // manifest digests), then the router emits its paired TaskCreated with
      // budget fields. The router handler's guards skip overwriting fields
      // already populated by the coordinator.
      let taskIdValue = BigInt.fromI32(7);
      let creator = Address.fromString(CREATOR_HEX);
      let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
      let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;
      seedCoordinatorTask(taskIdValue, creator, manifestDigest, taskCidDigest);

      let solutionBudget = BigInt.fromI32(500);
      let verdictBudget = BigInt.fromI32(250);
      let event = buildRouterTaskCreatedEvent(
        creator,
        taskIdValue,
        manifestDigest,
        taskCidDigest,
        4,
        2,
        solutionBudget,
        verdictBudget,
      );

      handleRouterTaskCreated(event);

      assert.fieldEquals("Task", "7", "taskId", "7");
      assert.fieldEquals("Task", "7", "creator", CREATOR_HEX);
      assert.fieldEquals(
        "Task",
        "7",
        "manifestDigest",
        MANIFEST_DIGEST_HEX,
      );
      assert.fieldEquals(
        "Task",
        "7",
        "taskCidDigest",
        TASK_CID_DIGEST_HEX,
      );
      // Router unconditionally overwrites maxClaims / requiredVerdicts —
      // both sides emit identical values in production.
      assert.fieldEquals("Task", "7", "maxClaims", "4");
      assert.fieldEquals("Task", "7", "requiredVerdicts", "2");
      assert.fieldEquals("Task", "7", "solutionBudget", "500");
      assert.fieldEquals("Task", "7", "verdictBudget", "250");
    },
  );

  test(
    "handleTaskAttemptCreated load-or-creates a TaskAttempt with operator",
    () => {
      // No prior Task — handler must auto-stub Task + Attempt.
      let taskIdValue = BigInt.fromI32(11);
      let attemptIndex = BigInt.fromI32(2);
      let requestId = Bytes.fromHexString(SOLUTION_REQUEST_ID_HEX) as Bytes;
      let operator = Address.fromString(OPERATOR_HEX);
      let priorityMech = Address.fromString(PRIORITY_MECH_HEX);
      let deliveryRate = BigInt.fromI32(100);

      let event = buildTaskAttemptCreatedEvent(
        taskIdValue,
        attemptIndex,
        requestId,
        operator,
        priorityMech,
        deliveryRate,
      );

      handleTaskAttemptCreated(event);

      assert.fieldEquals("TaskAttempt", "11-2", "task", "11");
      assert.fieldEquals("TaskAttempt", "11-2", "attemptIndex", "2");
      assert.fieldEquals("TaskAttempt", "11-2", "operator", OPERATOR_HEX);
      assert.fieldEquals(
        "TaskAttempt",
        "11-2",
        "solutionRequestId",
        SOLUTION_REQUEST_ID_HEX,
      );
    },
  );

  test(
    "handleEvaluationAttemptCreated load-or-creates a Verdict with evaluator",
    () => {
      let taskIdValue = BigInt.fromI32(11);
      let attemptIndex = BigInt.fromI32(0);
      let verdictIndex = BigInt.fromI32(1);
      let requestId = Bytes.fromHexString(VERDICT_REQUEST_ID_HEX) as Bytes;
      let evaluator = Address.fromString(EVALUATOR_HEX);
      let priorityMech = Address.fromString(PRIORITY_MECH_HEX);
      let deliveryRate = BigInt.fromI32(50);

      let event = buildEvaluationAttemptCreatedEvent(
        taskIdValue,
        attemptIndex,
        verdictIndex,
        requestId,
        evaluator,
        priorityMech,
        deliveryRate,
      );

      handleEvaluationAttemptCreated(event);

      assert.fieldEquals("Verdict", "11-0-1", "attempt", "11-0");
      assert.fieldEquals("Verdict", "11-0-1", "verdictIndex", "1");
      assert.fieldEquals("Verdict", "11-0-1", "evaluator", EVALUATOR_HEX);
      assert.fieldEquals(
        "Verdict",
        "11-0-1",
        "verdictRequestId",
        VERDICT_REQUEST_ID_HEX,
      );
      // Default status from load-or-create is CLAIMED — coordinator-side
      // VerdictDelivered is what flips it to DELIVERED.
      assert.fieldEquals("Verdict", "11-0-1", "status", "CLAIMED");
    },
  );

  test(
    "handleSolutionDeliveryClaimed ensures attempt row exists",
    () => {
      let taskIdValue = BigInt.fromI32(11);
      let attemptIndex = BigInt.fromI32(0);
      let requestId = Bytes.fromHexString(SOLUTION_REQUEST_ID_HEX) as Bytes;
      let operator = Address.fromString(OPERATOR_HEX);

      let event = buildSolutionDeliveryClaimedEvent(
        operator,
        requestId,
        taskIdValue,
        attemptIndex,
      );

      handleSolutionDeliveryClaimed(event);

      assert.fieldEquals("TaskAttempt", "11-0", "task", "11");
      assert.fieldEquals("TaskAttempt", "11-0", "operator", OPERATOR_HEX);
      assert.fieldEquals(
        "TaskAttempt",
        "11-0",
        "solutionRequestId",
        SOLUTION_REQUEST_ID_HEX,
      );
    },
  );

  test(
    "handleVerdictDeliveryClaimed mirrors verdictCode while status=CLAIMED",
    () => {
      let taskIdValue = BigInt.fromI32(11);
      let attemptIndex = BigInt.fromI32(0);
      let verdictIndex = BigInt.fromI32(0);
      let requestId = Bytes.fromHexString(VERDICT_REQUEST_ID_HEX) as Bytes;
      let evaluator = Address.fromString(EVALUATOR_HEX);

      let event = buildVerdictDeliveryClaimedEvent(
        evaluator,
        requestId,
        taskIdValue,
        attemptIndex,
        verdictIndex,
        2, // fail
      );

      handleVerdictDeliveryClaimed(event);

      assert.fieldEquals("Verdict", "11-0-0", "attempt", "11-0");
      assert.fieldEquals("Verdict", "11-0-0", "evaluator", EVALUATOR_HEX);
      assert.fieldEquals("Verdict", "11-0-0", "status", "CLAIMED");
      assert.fieldEquals(
        "Verdict",
        "11-0-0",
        "verdictRequestId",
        VERDICT_REQUEST_ID_HEX,
      );
      assert.fieldEquals("Verdict", "11-0-0", "verdictCode", "2");
    },
  );

  test(
    "handleTaskBudgetRefunded marks Task refunded with amounts",
    () => {
      // Seed via coordinator-side TaskCreated so creator/manifest are filled
      // by the canonical path before the refund event arrives.
      let taskIdValue = BigInt.fromI32(7);
      let creator = Address.fromString(CREATOR_HEX);
      let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
      let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;
      seedCoordinatorTask(taskIdValue, creator, manifestDigest, taskCidDigest);

      let event = buildTaskBudgetRefundedEvent(
        taskIdValue,
        creator,
        BigInt.fromI32(120),
        BigInt.fromI32(60),
      );

      handleTaskBudgetRefunded(event);

      assert.fieldEquals("Task", "7", "refunded", "true");
      assert.fieldEquals("Task", "7", "refundedSolutionAmount", "120");
      assert.fieldEquals("Task", "7", "refundedVerdictAmount", "60");
      assert.fieldEquals("Task", "7", "creator", CREATOR_HEX);
    },
  );
});
