import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cellIdempotencyKey, submissionExtensionBlock } from "@jinn-network/benchmarking-records";
import { documentDigest, sealSubmission, sealTask } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import {
  persistPreparedSubmission,
  recoverPreparedSubmission,
  type PreparedSubmissionExpectation,
} from "./prepared-submission.js";

const RUN = `sha256:${"a".repeat(64)}`;
const CAMPAIGN = `sha256:${"b".repeat(64)}`;
const TASK_HEX = "c".repeat(64);
const CELL = `${TASK_HEX}/armA/1`;

function fixture(root: string) {
  const taskBytes = sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "d".repeat(64) },
    },
    instructions: "Fix the bug.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
  const taskDigest = documentDigest(taskBytes);
  const idempotencyKey = cellIdempotencyKey(RUN, CELL, 1);
  const expectation: PreparedSubmissionExpectation & { stateRoot: string } = {
    stateRoot: root,
    campaign: CAMPAIGN,
    run: RUN,
    cellKey: CELL,
    armId: "armA",
    dispatch: 1,
    dispatchId: "solver/dispatch/1",
    requester: "urn:jinn:policy-optimization:requester",
    nonce: `${CELL}:1`,
    idempotencyKey,
    requirements: { loadout: { id: "learner-public", version: "1" } },
  };
  const submissionBytes = sealSubmission({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: "urn:uuid:11111111-1111-5111-8111-111111111111",
    task: { digest: { sha256: taskDigest.slice("sha256:".length) } },
    requester: expectation.requester,
    idempotencyKey,
    nonce: expectation.nonce,
    deadline: "2026-08-05T12:00:00Z",
    requirements: expectation.requirements,
    annotations: submissionExtensionBlock(RUN, CELL, "armA"),
  });
  return { expectation, taskBytes, submissionBytes };
}

function find(root: string, name: string): string {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = find(path, name);
      if (nested !== "") return nested;
    } else if (entry.name === name) return path;
  }
  return "";
}

describe("prepared Submission store", () => {
  test("persists exact Task and Submission bytes before returning and recovers them exactly", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-prepared-"));
    const input = fixture(root);
    const prepared = persistPreparedSubmission({
      ...input.expectation,
      taskBytes: input.taskBytes,
      submissionBytes: input.submissionBytes,
    });
    const recovered = recoverPreparedSubmission(input.expectation);
    expect(recovered.bindingDigest).toBe(prepared.bindingDigest);
    expect(recovered.taskBytes).toEqual(input.taskBytes);
    expect(recovered.submissionBytes).toEqual(input.submissionBytes);
  });

  test("refuses recovered Submission substitution and semantic-scope conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-prepared-adversarial-"));
    const input = fixture(root);
    persistPreparedSubmission({
      ...input.expectation,
      taskBytes: input.taskBytes,
      submissionBytes: input.submissionBytes,
    });

    expect(() => recoverPreparedSubmission({ ...input.expectation, requester: "urn:jinn:other" }))
      .toThrow(/requester/u);

    const submissionPath = find(root, "submission.sealed.json");
    expect(submissionPath).not.toBe("");
    const substituted = new Uint8Array(input.submissionBytes);
    substituted[substituted.length - 2] ^= 1;
    writeFileSync(submissionPath, substituted);
    expect(() => recoverPreparedSubmission(input.expectation)).toThrow(/exact|canonical|digest/u);
  });

  test("refuses a secret semantic change under the same dispatch identity", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-prepared-conflict-"));
    const input = fixture(root);
    persistPreparedSubmission({
      ...input.expectation,
      taskBytes: input.taskBytes,
      submissionBytes: input.submissionBytes,
    });
    expect(() => persistPreparedSubmission({
      ...input.expectation,
      taskBytes: input.taskBytes,
      submissionBytes: input.submissionBytes,
      requirements: { loadout: { id: "different", version: "1" } },
    })).toThrow(/requirements/u);
  });
});
