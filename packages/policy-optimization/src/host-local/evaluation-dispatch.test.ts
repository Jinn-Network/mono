import { DeliveryRecordSchema, documentDigest, sealDelivery, sealTask } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import { deriveEvaluationDispatch } from "./evaluation-dispatch.js";

const CAMPAIGN = `sha256:${"1".repeat(64)}`;
const RUN = `sha256:${"2".repeat(64)}`;
const CELL = `${"3".repeat(64)}/armA/1`;

function fixture() {
  const taskBytes = sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "4".repeat(64) },
    },
    instructions: "Fix the bug.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
  const deliveryRecord = DeliveryRecordSchema.parse({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    attempt: "urn:uuid:11111111-1111-5111-8111-111111111111",
    task: documentDigest(taskBytes),
    outputs: [{ name: "patch", mediaType: "text/x-diff", digest: { sha256: "5".repeat(64) } }],
    outcome: "fulfilled",
    createdAt: "2026-08-05T12:00:00Z",
  });
  const deliveryBytes = sealDelivery(deliveryRecord);
  return { taskBytes, deliveryRecord, deliveryBytes };
}

function derive() {
  const material = fixture();
  return deriveEvaluationDispatch({
    campaign: CAMPAIGN,
    run: RUN,
    cellKey: CELL,
    armId: "armA",
    dispatch: 1,
    requester: "urn:jinn:evaluator-requester",
    deadline: "2026-08-05T13:00:00Z",
    requirements: { harness: { id: "evaluation-harness", version: "1" } },
    subjectTask: { bytes: material.taskBytes },
    solverDelivery: { bytes: material.deliveryBytes, record: material.deliveryRecord },
    evaluationSpecDigest: `sha256:${"6".repeat(64)}`,
  });
}

describe("deterministic evaluation dispatch", () => {
  test("independent derivations produce exact identical Task and Submission identities", () => {
    const first = derive();
    const second = derive();
    expect(first.taskBytes).toEqual(second.taskBytes);
    expect(first.taskDigest).toBe(second.taskDigest);
    expect(first.submissionBytes).toEqual(second.submissionBytes);
    expect(first.submissionDigest).toBe(second.submissionDigest);
    expect(first.expectation).toEqual(second.expectation);
  });

  test("preserves Delivery output names in the evaluation subject bindings", () => {
    const derived = derive();
    const task = JSON.parse(new TextDecoder().decode(derived.taskBytes)) as {
      payload: { subjectResults: readonly { name: string }[] };
    };

    expect(task.payload.subjectResults).toEqual([
      expect.objectContaining({ name: "patch" }),
    ]);
  });

  test("refuses a Delivery object substituted beside different exact bytes", () => {
    const material = fixture();
    const substituted = DeliveryRecordSchema.parse({
      ...material.deliveryRecord,
      outputs: [{ name: "patch", mediaType: "text/x-diff", digest: { sha256: "7".repeat(64) } }],
    });
    expect(() => deriveEvaluationDispatch({
      campaign: CAMPAIGN,
      run: RUN,
      cellKey: CELL,
      armId: "armA",
      dispatch: 1,
      requester: "urn:jinn:evaluator-requester",
      deadline: "2026-08-05T13:00:00Z",
      requirements: {},
      subjectTask: { bytes: material.taskBytes },
      solverDelivery: { bytes: material.deliveryBytes, record: substituted },
      evaluationSpecDigest: `sha256:${"6".repeat(64)}`,
    })).toThrow(/diverge/u);
  });
});
