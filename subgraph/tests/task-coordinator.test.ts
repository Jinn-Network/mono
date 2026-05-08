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
  crypto,
} from "@graphprotocol/graph-ts";

import {
  handleTaskCreated,
  handleTaskClaimed,
  handleTaskAttemptRequestRegistered,
  handleTaskSubmitted,
  handleEvaluationClaimed,
  handleVerdictRequestRegistered,
  handleVerdictDelivered,
  handleAttemptFinalized,
  handleTaskCreationCreditLocked,
  handleTaskAttemptExpired,
} from "../src/handlers/task-coordinator";
import {
  TaskCreated,
  TaskClaimed,
  TaskAttemptRequestRegistered,
  TaskSubmitted,
  EvaluationClaimed,
  VerdictRequestRegistered,
  VerdictDelivered,
  AttemptFinalized,
  TaskCreationCreditLocked,
  TaskAttemptExpired,
} from "../generated/TaskCoordinator/TaskCoordinator";

import { handleMetadataSet } from "../src/handlers/identity";
import { MetadataSet } from "../generated/IdentityRegistry/IdentityRegistry";

// ────────────────────────────────────────────────────────────────────────────
// Constants used across tests
// ────────────────────────────────────────────────────────────────────────────
const CREATOR_HEX = "0x1234567890123456789012345678901234567890";
const OPERATOR_HEX = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const EVALUATOR_HEX = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed";
const MANIFEST_DIGEST_HEX =
  "0xabababababababababababababababababababababababababababababababab";
const TASK_CID_DIGEST_HEX =
  "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const SOLUTION_REQUEST_ID_HEX =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const SOLUTION_CID_DIGEST_HEX =
  "0x2222222222222222222222222222222222222222222222222222222222222222";
const VERDICT_REQUEST_ID_HEX =
  "0x3333333333333333333333333333333333333333333333333333333333333333";
const VERDICT_CID_DIGEST_HEX =
  "0x4444444444444444444444444444444444444444444444444444444444444444";
const METADATA_PAYLOAD_HEX =
  "0xefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef";
const TX_HASH_HEX =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
function buildTaskCreatedEvent(
  taskId: BigInt,
  creator: Address,
  manifestDigest: Bytes,
  taskCidDigest: Bytes,
): TaskCreated {
  let event = changetype<TaskCreated>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("taskId", ethereum.Value.fromUnsignedBigInt(taskId)),
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
  return event;
}

function buildTaskClaimedEvent(
  taskId: BigInt,
  attemptIndex: BigInt,
  operator: Address,
  claimExpiresAt: BigInt,
): TaskClaimed {
  let event = changetype<TaskClaimed>(newMockEvent());
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
    new ethereum.EventParam("operator", ethereum.Value.fromAddress(operator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "claimExpiresAt",
      ethereum.Value.fromUnsignedBigInt(claimExpiresAt),
    ),
  );
  return event;
}

function buildMetadataSetEvent(
  agentId: BigInt,
  metadataKey: string,
  metadataValue: Bytes,
  txHash: Bytes,
  logIndex: BigInt,
): MetadataSet {
  let event = changetype<MetadataSet>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam(
      "agentId",
      ethereum.Value.fromUnsignedBigInt(agentId),
    ),
  );
  // indexedMetadataKey is the keccak256 of the readable key, but the handler
  // never reads it — supply a stand-in keccak so the param shape is honest.
  let indexed = changetype<Bytes>(crypto.keccak256(Bytes.fromUTF8(metadataKey)));
  event.parameters.push(
    new ethereum.EventParam(
      "indexedMetadataKey",
      ethereum.Value.fromFixedBytes(indexed),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "metadataKey",
      ethereum.Value.fromString(metadataKey),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "metadataValue",
      ethereum.Value.fromBytes(metadataValue),
    ),
  );
  event.transaction.hash = txHash;
  event.logIndex = logIndex;
  return event;
}

function buildTaskAttemptRequestRegisteredEvent(
  taskId: BigInt,
  attemptIndex: BigInt,
  requestId: Bytes,
): TaskAttemptRequestRegistered {
  let event = changetype<TaskAttemptRequestRegistered>(newMockEvent());
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
  return event;
}

function buildTaskSubmittedEvent(
  taskId: BigInt,
  attemptIndex: BigInt,
  operator: Address,
  requestId: Bytes,
  solutionCidDigest: Bytes,
  solutionWeight: BigInt,
): TaskSubmitted {
  let event = changetype<TaskSubmitted>(newMockEvent());
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
    new ethereum.EventParam("operator", ethereum.Value.fromAddress(operator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "requestId",
      ethereum.Value.fromFixedBytes(requestId),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "solutionCidDigest",
      ethereum.Value.fromFixedBytes(solutionCidDigest),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "solutionWeight",
      ethereum.Value.fromUnsignedBigInt(solutionWeight),
    ),
  );
  return event;
}

function buildEvaluationClaimedEvent(
  taskId: BigInt,
  attemptIndex: BigInt,
  verdictIndex: BigInt,
  evaluator: Address,
  claimExpiresAt: BigInt,
): EvaluationClaimed {
  let event = changetype<EvaluationClaimed>(newMockEvent());
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
    new ethereum.EventParam("evaluator", ethereum.Value.fromAddress(evaluator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "claimExpiresAt",
      ethereum.Value.fromUnsignedBigInt(claimExpiresAt),
    ),
  );
  return event;
}

function buildVerdictRequestRegisteredEvent(
  taskId: BigInt,
  attemptIndex: BigInt,
  verdictIndex: BigInt,
  requestId: Bytes,
): VerdictRequestRegistered {
  let event = changetype<VerdictRequestRegistered>(newMockEvent());
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
  return event;
}

function buildVerdictDeliveredEvent(
  taskId: BigInt,
  attemptIndex: BigInt,
  verdictIndex: BigInt,
  evaluator: Address,
  verdictCidDigest: Bytes,
  verdictCode: i32,
): VerdictDelivered {
  let event = changetype<VerdictDelivered>(newMockEvent());
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
    new ethereum.EventParam("evaluator", ethereum.Value.fromAddress(evaluator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "verdictCidDigest",
      ethereum.Value.fromFixedBytes(verdictCidDigest),
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

function buildAttemptFinalizedEvent(
  taskId: BigInt,
  attemptIndex: BigInt,
  passed: boolean,
  validVerdictCount: i32,
  passVerdictCount: i32,
): AttemptFinalized {
  let event = changetype<AttemptFinalized>(newMockEvent());
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
    new ethereum.EventParam("passed", ethereum.Value.fromBoolean(passed)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "validVerdictCount",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(validVerdictCount)),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "passVerdictCount",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(passVerdictCount)),
    ),
  );
  return event;
}

function buildTaskCreationCreditLockedEvent(
  taskId: BigInt,
  creator: Address,
  weight: BigInt,
): TaskCreationCreditLocked {
  let event = changetype<TaskCreationCreditLocked>(newMockEvent());
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("taskId", ethereum.Value.fromUnsignedBigInt(taskId)),
  );
  event.parameters.push(
    new ethereum.EventParam("creator", ethereum.Value.fromAddress(creator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "weight",
      ethereum.Value.fromUnsignedBigInt(weight),
    ),
  );
  return event;
}

function buildTaskAttemptExpiredEvent(
  taskId: BigInt,
  attemptIndex: BigInt,
  operator: Address,
): TaskAttemptExpired {
  let event = changetype<TaskAttemptExpired>(newMockEvent());
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
    new ethereum.EventParam("operator", ethereum.Value.fromAddress(operator)),
  );
  return event;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────
describe("TaskCoordinator V3 handlers", () => {
  beforeEach(() => {
    clearStore();
  });

  test("handleTaskCreated creates a Task with manifestDigest", () => {
    let taskId = BigInt.fromI32(42);
    let creator = Address.fromString(CREATOR_HEX);
    let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
    let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;

    let event = buildTaskCreatedEvent(
      taskId,
      creator,
      manifestDigest,
      taskCidDigest,
    );

    handleTaskCreated(event);

    assert.fieldEquals("Task", "42", "taskId", "42");
    assert.fieldEquals("Task", "42", "creator", CREATOR_HEX);
    assert.fieldEquals(
      "Task",
      "42",
      "manifestDigest",
      MANIFEST_DIGEST_HEX,
    );
    assert.fieldEquals(
      "Task",
      "42",
      "taskCidDigest",
      TASK_CID_DIGEST_HEX,
    );
    assert.fieldEquals("Task", "42", "maxClaims", "3");
    assert.fieldEquals("Task", "42", "requiredVerdicts", "1");
    assert.fieldEquals("Task", "42", "finalized", "false");
  });

  test("handleTaskClaimed creates TaskAttempt with status=CLAIMED", () => {
    // Seed the Task so the attempt's foreign key points at a real row.
    let taskId = BigInt.fromI32(42);
    let creator = Address.fromString(CREATOR_HEX);
    let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
    let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;
    handleTaskCreated(
      buildTaskCreatedEvent(taskId, creator, manifestDigest, taskCidDigest),
    );

    let attemptIndex = BigInt.fromI32(0);
    let operator = Address.fromString(OPERATOR_HEX);
    let claimExpiresAt = BigInt.fromI32(1700004000);
    let claimEvent = buildTaskClaimedEvent(
      taskId,
      attemptIndex,
      operator,
      claimExpiresAt,
    );

    handleTaskClaimed(claimEvent);

    let id = "42-0";
    assert.fieldEquals("TaskAttempt", id, "task", "42");
    assert.fieldEquals("TaskAttempt", id, "attemptIndex", "0");
    assert.fieldEquals("TaskAttempt", id, "operator", OPERATOR_HEX);
    assert.fieldEquals("TaskAttempt", id, "status", "CLAIMED");
    assert.fieldEquals(
      "TaskAttempt",
      id,
      "claimExpiresAt",
      claimExpiresAt.toString(),
    );
    assert.fieldEquals("TaskAttempt", id, "finalized", "false");
  });

  test(
    "handleMetadataSet with solvernet-manifest:<cid> creates SolverNetManifestEvent",
    () => {
      let agentId = BigInt.fromI32(5474);
      let cid = "bafkreitest1234567890";
      let key = "solvernet-manifest:" + cid;
      let payload = Bytes.fromHexString(METADATA_PAYLOAD_HEX) as Bytes;
      let txHash = Bytes.fromHexString(TX_HASH_HEX) as Bytes;
      let logIndex = BigInt.fromI32(7);

      let event = buildMetadataSetEvent(
        agentId,
        key,
        payload,
        txHash,
        logIndex,
      );

      handleMetadataSet(event);

      // SolverNetManifestEvent id is `<txHashHex>-<logIndexDec>`.
      let evtId = TX_HASH_HEX + "-7";
      assert.fieldEquals(
        "SolverNetManifestEvent",
        evtId,
        "agentId",
        "5474",
      );
      assert.fieldEquals(
        "SolverNetManifestEvent",
        evtId,
        "operator",
        "5474",
      );
      assert.fieldEquals(
        "SolverNetManifestEvent",
        evtId,
        "metadataKey",
        key,
      );
      assert.fieldEquals(
        "SolverNetManifestEvent",
        evtId,
        "manifestCid",
        cid,
      );
      assert.fieldEquals(
        "SolverNetManifestEvent",
        evtId,
        "logIndex",
        "7",
      );

      // The handler also falls through to the legacy MetadataEntry catch-all.
      // MetadataEntry id == `<agentId>-<keccak256(key hex)>`.
      let keyHash = changetype<Bytes>(crypto.keccak256(Bytes.fromUTF8(key)));
      let metadataEntryEntityId =
        agentId.toString() + "-" + keyHash.toHexString();
      assert.fieldEquals(
        "MetadataEntry",
        metadataEntryEntityId,
        "metadataKey",
        key,
      );
      assert.fieldEquals(
        "MetadataEntry",
        metadataEntryEntityId,
        "updateCount",
        "1",
      );
    },
  );

  test(
    "handleTaskAttemptRequestRegistered fills in solutionRequestId on attempt",
    () => {
      let taskIdValue = BigInt.fromI32(42);
      let creator = Address.fromString(CREATOR_HEX);
      let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
      let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;
      handleTaskCreated(
        buildTaskCreatedEvent(
          taskIdValue,
          creator,
          manifestDigest,
          taskCidDigest,
        ),
      );

      let attemptIndex = BigInt.fromI32(0);
      let requestId = Bytes.fromHexString(SOLUTION_REQUEST_ID_HEX) as Bytes;
      let event = buildTaskAttemptRequestRegisteredEvent(
        taskIdValue,
        attemptIndex,
        requestId,
      );

      handleTaskAttemptRequestRegistered(event);

      assert.fieldEquals(
        "TaskAttempt",
        "42-0",
        "solutionRequestId",
        SOLUTION_REQUEST_ID_HEX,
      );
      assert.fieldEquals("TaskAttempt", "42-0", "task", "42");
    },
  );

  test(
    "handleTaskSubmitted transitions CLAIMED → SUBMITTED with payload",
    () => {
      let taskIdValue = BigInt.fromI32(42);
      let creator = Address.fromString(CREATOR_HEX);
      let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
      let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;
      handleTaskCreated(
        buildTaskCreatedEvent(
          taskIdValue,
          creator,
          manifestDigest,
          taskCidDigest,
        ),
      );
      // Pre-seed claim so status starts at CLAIMED.
      let operator = Address.fromString(OPERATOR_HEX);
      handleTaskClaimed(
        buildTaskClaimedEvent(
          taskIdValue,
          BigInt.fromI32(0),
          operator,
          BigInt.fromI32(1700004000),
        ),
      );

      let requestId = Bytes.fromHexString(SOLUTION_REQUEST_ID_HEX) as Bytes;
      let solutionCidDigest = Bytes.fromHexString(
        SOLUTION_CID_DIGEST_HEX,
      ) as Bytes;
      let solutionWeight = BigInt.fromI32(7777);
      let event = buildTaskSubmittedEvent(
        taskIdValue,
        BigInt.fromI32(0),
        operator,
        requestId,
        solutionCidDigest,
        solutionWeight,
      );

      handleTaskSubmitted(event);

      let id = "42-0";
      assert.fieldEquals("TaskAttempt", id, "status", "SUBMITTED");
      assert.fieldEquals(
        "TaskAttempt",
        id,
        "solutionRequestId",
        SOLUTION_REQUEST_ID_HEX,
      );
      assert.fieldEquals(
        "TaskAttempt",
        id,
        "solutionCidDigest",
        SOLUTION_CID_DIGEST_HEX,
      );
      assert.fieldEquals("TaskAttempt", id, "solutionWeight", "7777");
      assert.fieldEquals("TaskAttempt", id, "operator", OPERATOR_HEX);
    },
  );

  test("handleEvaluationClaimed creates Verdict with status=CLAIMED", () => {
    let taskIdValue = BigInt.fromI32(42);
    let creator = Address.fromString(CREATOR_HEX);
    let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
    let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;
    handleTaskCreated(
      buildTaskCreatedEvent(
        taskIdValue,
        creator,
        manifestDigest,
        taskCidDigest,
      ),
    );
    let operator = Address.fromString(OPERATOR_HEX);
    handleTaskClaimed(
      buildTaskClaimedEvent(
        taskIdValue,
        BigInt.fromI32(0),
        operator,
        BigInt.fromI32(1700004000),
      ),
    );

    let evaluator = Address.fromString(EVALUATOR_HEX);
    let claimExpiresAt = BigInt.fromI32(1700009000);
    let event = buildEvaluationClaimedEvent(
      taskIdValue,
      BigInt.fromI32(0),
      BigInt.fromI32(0),
      evaluator,
      claimExpiresAt,
    );

    handleEvaluationClaimed(event);

    let id = "42-0-0";
    assert.fieldEquals("Verdict", id, "attempt", "42-0");
    assert.fieldEquals("Verdict", id, "verdictIndex", "0");
    assert.fieldEquals("Verdict", id, "evaluator", EVALUATOR_HEX);
    assert.fieldEquals("Verdict", id, "status", "CLAIMED");
    assert.fieldEquals(
      "Verdict",
      id,
      "claimExpiresAt",
      claimExpiresAt.toString(),
    );
  });

  test(
    "handleVerdictRequestRegistered fills in verdictRequestId",
    () => {
      let taskIdValue = BigInt.fromI32(42);
      let creator = Address.fromString(CREATOR_HEX);
      let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
      let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;
      handleTaskCreated(
        buildTaskCreatedEvent(
          taskIdValue,
          creator,
          manifestDigest,
          taskCidDigest,
        ),
      );
      let evaluator = Address.fromString(EVALUATOR_HEX);
      handleEvaluationClaimed(
        buildEvaluationClaimedEvent(
          taskIdValue,
          BigInt.fromI32(0),
          BigInt.fromI32(0),
          evaluator,
          BigInt.fromI32(1700009000),
        ),
      );

      let requestId = Bytes.fromHexString(VERDICT_REQUEST_ID_HEX) as Bytes;
      let event = buildVerdictRequestRegisteredEvent(
        taskIdValue,
        BigInt.fromI32(0),
        BigInt.fromI32(0),
        requestId,
      );

      handleVerdictRequestRegistered(event);

      assert.fieldEquals(
        "Verdict",
        "42-0-0",
        "verdictRequestId",
        VERDICT_REQUEST_ID_HEX,
      );
    },
  );

  test(
    "handleVerdictDelivered transitions Verdict to DELIVERED with code",
    () => {
      let taskIdValue = BigInt.fromI32(42);
      let creator = Address.fromString(CREATOR_HEX);
      let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
      let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;
      handleTaskCreated(
        buildTaskCreatedEvent(
          taskIdValue,
          creator,
          manifestDigest,
          taskCidDigest,
        ),
      );
      let evaluator = Address.fromString(EVALUATOR_HEX);
      handleEvaluationClaimed(
        buildEvaluationClaimedEvent(
          taskIdValue,
          BigInt.fromI32(0),
          BigInt.fromI32(0),
          evaluator,
          BigInt.fromI32(1700009000),
        ),
      );

      let verdictCidDigest = Bytes.fromHexString(
        VERDICT_CID_DIGEST_HEX,
      ) as Bytes;
      let event = buildVerdictDeliveredEvent(
        taskIdValue,
        BigInt.fromI32(0),
        BigInt.fromI32(0),
        evaluator,
        verdictCidDigest,
        1, // pass
      );

      handleVerdictDelivered(event);

      let id = "42-0-0";
      assert.fieldEquals("Verdict", id, "status", "DELIVERED");
      assert.fieldEquals(
        "Verdict",
        id,
        "verdictCidDigest",
        VERDICT_CID_DIGEST_HEX,
      );
      assert.fieldEquals("Verdict", id, "verdictCode", "1");
      assert.fieldEquals("Verdict", id, "evaluator", EVALUATOR_HEX);
    },
  );

  test(
    "handleAttemptFinalized flips attempt + task finalized when passed",
    () => {
      let taskIdValue = BigInt.fromI32(42);
      let creator = Address.fromString(CREATOR_HEX);
      let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
      let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;
      handleTaskCreated(
        buildTaskCreatedEvent(
          taskIdValue,
          creator,
          manifestDigest,
          taskCidDigest,
        ),
      );
      let operator = Address.fromString(OPERATOR_HEX);
      handleTaskClaimed(
        buildTaskClaimedEvent(
          taskIdValue,
          BigInt.fromI32(0),
          operator,
          BigInt.fromI32(1700004000),
        ),
      );

      let event = buildAttemptFinalizedEvent(
        taskIdValue,
        BigInt.fromI32(0),
        true,
        2,
        2,
      );

      handleAttemptFinalized(event);

      let attemptIdStr = "42-0";
      assert.fieldEquals("TaskAttempt", attemptIdStr, "status", "FINALIZED");
      assert.fieldEquals("TaskAttempt", attemptIdStr, "finalized", "true");
      assert.fieldEquals("TaskAttempt", attemptIdStr, "passed", "true");
      assert.fieldEquals(
        "TaskAttempt",
        attemptIdStr,
        "validVerdictCount",
        "2",
      );
      assert.fieldEquals(
        "TaskAttempt",
        attemptIdStr,
        "passVerdictCount",
        "2",
      );
      // Task.finalized propagates only on pass.
      assert.fieldEquals("Task", "42", "finalized", "true");
    },
  );

  test(
    "handleTaskCreationCreditLocked preserves existing creator on a known Task",
    () => {
      // Seed the canonical Task first so the handler's existence check holds.
      let taskIdValue = BigInt.fromI32(42);
      let creator = Address.fromString(CREATOR_HEX);
      let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
      let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;
      handleTaskCreated(
        buildTaskCreatedEvent(
          taskIdValue,
          creator,
          manifestDigest,
          taskCidDigest,
        ),
      );

      // Different creator on credit-locked event — handler must NOT overwrite.
      let differentCreator = Address.fromString(
        "0x0000000000000000000000000000000000099999",
      );
      let event = buildTaskCreationCreditLockedEvent(
        taskIdValue,
        differentCreator,
        BigInt.fromI32(1234),
      );

      handleTaskCreationCreditLocked(event);

      // The original TaskCreated creator is preserved.
      assert.fieldEquals("Task", "42", "creator", CREATOR_HEX);
      assert.fieldEquals("Task", "42", "finalized", "false");
    },
  );

  test(
    "handleTaskAttemptExpired flips attempt status to EXPIRED",
    () => {
      let taskIdValue = BigInt.fromI32(42);
      let creator = Address.fromString(CREATOR_HEX);
      let manifestDigest = Bytes.fromHexString(MANIFEST_DIGEST_HEX) as Bytes;
      let taskCidDigest = Bytes.fromHexString(TASK_CID_DIGEST_HEX) as Bytes;
      handleTaskCreated(
        buildTaskCreatedEvent(
          taskIdValue,
          creator,
          manifestDigest,
          taskCidDigest,
        ),
      );
      let operator = Address.fromString(OPERATOR_HEX);
      handleTaskClaimed(
        buildTaskClaimedEvent(
          taskIdValue,
          BigInt.fromI32(0),
          operator,
          BigInt.fromI32(1700004000),
        ),
      );

      let event = buildTaskAttemptExpiredEvent(
        taskIdValue,
        BigInt.fromI32(0),
        operator,
      );

      handleTaskAttemptExpired(event);

      assert.fieldEquals("TaskAttempt", "42-0", "status", "EXPIRED");
      assert.fieldEquals("TaskAttempt", "42-0", "operator", OPERATOR_HEX);
    },
  );

  test("handleMetadataSet with capture:<cid> indexes CaptureEnvelope aggregates", () => {
    let agentId = BigInt.fromI32(5474);
    let cid = "bafkreicapture1234567890";
    let key = "capture:" + cid;
    let payload = Bytes.fromHexString(METADATA_PAYLOAD_HEX) as Bytes;
    let txHash = Bytes.fromHexString(TX_HASH_HEX) as Bytes;
    let logIndex = BigInt.fromI32(8);

    let event = buildMetadataSetEvent(agentId, key, payload, txHash, logIndex);
    handleMetadataSet(event);

    assert.fieldEquals("CaptureEnvelope", cid, "operator", "5474");
    assert.fieldEquals("CaptureEnvelope", cid, "manifestCid", cid);
    assert.fieldEquals("CaptureEnvelope", cid, "repoKey", "unknown");
    assert.fieldEquals("CaptureEnvelope", cid, "tier", "UNKNOWN");
    assert.fieldEquals("CaptureEnvelope", cid, "publishCount", "1");
    assert.fieldEquals("CapturesByOperator", "5474", "operator", "5474");
    assert.fieldEquals("CapturesByOperator", "5474", "captureCount", "1");
    assert.fieldEquals("CapturesByRepo", "unknown", "repoKey", "unknown");
    assert.fieldEquals("CapturesByRepo", "unknown", "captureCount", "1");
  });
});
