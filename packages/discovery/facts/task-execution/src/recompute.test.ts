import { readFile } from "node:fs/promises";

import { RECORD_KINDS, recordDigest } from "@jinn-network/record-discovery-protocol";
import type { ReferencedBytes } from "@jinn-network/record-discovery-protocol";
import { sealDelivery, sealSubmission } from "@jinn-network/task-execution-protocol";
import { describe, expect, it } from "vitest";

import {
  TASK_EXECUTION_FACTS_RECOMPUTE,
  checkpointRecompute,
  deliveryRecompute,
  evaluationSpecRecompute,
  pluginRecompute,
  profileDocumentRecompute,
  submissionRecompute,
  taskRecompute,
} from "./recompute.js";

const noReferencedBytes: ReferencedBytes = {
  async "fetch"() {
    return undefined;
  },
};

async function fixtureBytes(specifier: string): Promise<Uint8Array> {
  const url = import.meta.resolve(specifier);
  return new Uint8Array(await readFile(new URL(url)));
}

async function loadGoldenTaskBytes(): Promise<Uint8Array> {
  return fixtureBytes("@jinn-network/task-execution-protocol/fixtures/golden-task-execution-v1/task.json");
}

async function loadGoldenSubmissionBytes(): Promise<Uint8Array> {
  return fixtureBytes("@jinn-network/task-execution-protocol/fixtures/golden-task-execution-v1/local/submission.json");
}

async function loadGoldenDeliveryBytes(): Promise<Uint8Array> {
  return fixtureBytes("@jinn-network/task-execution-protocol/fixtures/golden-task-execution-v1/local/delivery.json");
}

async function loadRepositoryWorkProfileBytes(): Promise<Uint8Array> {
  return fixtureBytes("@jinn-network/task-execution-profiles/profiles/task-profiles/repository-work/1.0/profile.json");
}

async function loadSweRebenchEvaluationSpecBytes(): Promise<Uint8Array> {
  return fixtureBytes("@jinn-network/task-execution-profiles/fixtures/swe-rebench-golden/golden/evaluation-spec.sealed.json");
}

describe("facts/task-execution recompute functions", () => {
  it("recomputes Task record facts straight from the sealed bytes", async () => {
    const bytes = await loadGoldenTaskBytes();
    const facts = await taskRecompute(bytes, noReferencedBytes);
    expect(facts).toEqual({
      profileUri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      profileDigest: "sha256:3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6",
      author: undefined,
      evaluationDigest: undefined,
      supersedesDigest: undefined,
    });
  });

  it("recomputes Submission record facts, drawing taskProfileUri from the referenced Task's bytes", async () => {
    const submissionBytes = await loadGoldenSubmissionBytes();
    const taskBytes = await loadGoldenTaskBytes();
    const refs: ReferencedBytes = {
      async "fetch"(digest) {
        return digest === recordDigest(taskBytes) ? taskBytes : undefined;
      },
    };
    const facts = await submissionRecompute(submissionBytes, refs);
    expect(facts).toEqual({
      taskDigest: recordDigest(taskBytes),
      taskProfileUri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      requesterIri: "urn:uuid:cccccccc-cccc-5ccc-8ccc-cccccccccccc",
      deadline: "2026-07-29T00:00:00Z",
      benchrun: undefined,
      benchcell: undefined,
      bencharm: undefined,
    });
  });

  it("Submission taskProfileUri recomputes to undefined (indeterminate) when the referenced Task bytes are unavailable", async () => {
    const submissionBytes = await loadGoldenSubmissionBytes();
    const facts = await submissionRecompute(submissionBytes, noReferencedBytes);
    expect(facts.taskProfileUri).toBeUndefined();
    expect(facts.requesterIri).toBe("urn:uuid:cccccccc-cccc-5ccc-8ccc-cccccccccccc");
  });

  it("recomputes the optional benchrun/benchcell/bencharm triple from a Submission's annotations when present (Addendum 2026-07-28-b)", async () => {
    const taskBytes = await loadGoldenTaskBytes();
    const taskDigestHex = recordDigest(taskBytes).slice("sha256:".length);
    const bytes = sealSubmission({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission: "urn:uuid:dddddddd-dddd-5ddd-8ddd-dddddddddddd",
      task: { digest: { sha256: taskDigestHex } },
      requester: "urn:uuid:eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee",
      idempotencyKey: "bench-1",
      nonce: "bench-nonce-1",
      deadline: "2026-08-01T00:00:00Z",
      annotations: {
        run: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        cellKey: "sha256:2222222222222222222222222222222222222222222222222222222222222222/arm-a/1",
        armId: "arm-a",
      },
    });
    const refs: ReferencedBytes = {
      async "fetch"(digest) {
        return digest === recordDigest(taskBytes) ? taskBytes : undefined;
      },
    };
    const facts = await submissionRecompute(bytes, refs);
    expect(facts.benchrun).toBe("sha256:1111111111111111111111111111111111111111111111111111111111111111");
    expect(facts.benchcell).toBe("sha256:2222222222222222222222222222222222222222222222222222222222222222/arm-a/1");
    expect(facts.bencharm).toBe("arm-a");
  });

  it("recomputes Delivery record facts", async () => {
    const bytes = await loadGoldenDeliveryBytes();
    const facts = await deliveryRecompute(bytes, noReferencedBytes);
    expect(facts).toEqual({
      // The golden Delivery's own `task` field, re-sealed by the migration (DR-2026-08-04).
      taskDigest: "sha256:fc1a04cdbafaa835006e85d81ba952e6d4fcb02bc9166f7848f0e4def21bd607",
      attemptUri: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
      outcome: "fulfilled",
      benchrun: undefined,
      benchcell: undefined,
      bencharm: undefined,
    });
  });

  it("recomputes the optional benchrun/benchcell/bencharm triple from a Delivery's own namespaced extension fields when present", async () => {
    const bytes = sealDelivery({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
      task: "sha256:2b929dcdfe77f88e8bbb97f04381798e84db81925f2dda884bedc2ac587b27a0",
      outputs: [],
      outcome: "fulfilled",
      createdAt: "2026-08-01T00:05:00Z",
      run: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      cellKey: "sha256:2222222222222222222222222222222222222222222222222222222222222222/arm-a/1",
      armId: "arm-a",
    });
    const facts = await deliveryRecompute(bytes, noReferencedBytes);
    expect(facts.benchrun).toBe("sha256:1111111111111111111111111111111111111111111111111111111111111111");
    expect(facts.benchcell).toBe("sha256:2222222222222222222222222222222222222222222222222222222222222222/arm-a/1");
    expect(facts.bencharm).toBe("arm-a");
  });

  it("recomputes profile-document record facts from a real published task profile", async () => {
    const bytes = await loadRepositoryWorkProfileBytes();
    const facts = await profileDocumentRecompute(bytes, noReferencedBytes);
    expect(facts).toEqual({
      profile: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      extendsDigest: undefined,
    });
  });

  it("recomputes evaluation-spec record facts from a real sealed evaluation spec", async () => {
    const bytes = await loadSweRebenchEvaluationSpecBytes();
    const facts = await evaluationSpecRecompute(bytes, noReferencedBytes);
    expect(facts).toEqual({ family: "deterministic-process" });
  });

  it("plugin and checkpoint recompute to no facts (no defining-bytes schema exists yet, documented gap)", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ anything: "goes" }));
    expect(await pluginRecompute(bytes, noReferencedBytes)).toEqual({});
    expect(await checkpointRecompute(bytes, noReferencedBytes)).toEqual({});
  });

  it("recomputes to no facts for bytes that do not conform -- never silently consistent", async () => {
    const bytes = new TextEncoder().encode("{");
    expect(await taskRecompute(bytes, noReferencedBytes)).toEqual({});
    expect(await submissionRecompute(bytes, noReferencedBytes)).toEqual({});
    expect(await deliveryRecompute(bytes, noReferencedBytes)).toEqual({});
    expect(await profileDocumentRecompute(bytes, noReferencedBytes)).toEqual({});
    expect(await evaluationSpecRecompute(bytes, noReferencedBytes)).toEqual({});
  });

  it("the FactsRecompute registry resolves each of the seven kinds and nothing else", () => {
    expect(TASK_EXECUTION_FACTS_RECOMPUTE.get(RECORD_KINDS.task)).toBe(taskRecompute);
    expect(TASK_EXECUTION_FACTS_RECOMPUTE.get(RECORD_KINDS.submission)).toBe(submissionRecompute);
    expect(TASK_EXECUTION_FACTS_RECOMPUTE.get(RECORD_KINDS.delivery)).toBe(deliveryRecompute);
    expect(TASK_EXECUTION_FACTS_RECOMPUTE.get(RECORD_KINDS.profileDocument)).toBe(profileDocumentRecompute);
    expect(TASK_EXECUTION_FACTS_RECOMPUTE.get(RECORD_KINDS.evaluationSpec)).toBe(evaluationSpecRecompute);
    expect(TASK_EXECUTION_FACTS_RECOMPUTE.get(RECORD_KINDS.plugin)).toBe(pluginRecompute);
    expect(TASK_EXECUTION_FACTS_RECOMPUTE.get(RECORD_KINDS.checkpoint)).toBe(checkpointRecompute);
    expect(TASK_EXECUTION_FACTS_RECOMPUTE.get(RECORD_KINDS.executionEvidence)).toBeUndefined();
  });
});
