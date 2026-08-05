import { canonicalJsonBytes, prefixedDigest } from "@jinn-network/policy-identity";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { sealDsseEnvelope } from "@jinn-network/trust-core";
import { describe, expect, test, vi } from "vitest";
import {
  readVerifiedSupplyPool,
  type LiveSupplyPoolEntry,
  type LiveSupplyPoolSummary,
} from "./supply-pool.js";

function fixture() {
  const evaluationSpecBytes = canonicalJsonBytes({ kind: "swe-rebench", accessClass: "public" });
  const evaluationSpecDigest = prefixedDigest(evaluationSpecBytes);
  const taskBytes = sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "1".repeat(64) },
    },
    instructions: "Repair the exact admitted work item.",
    payload: {
      instance_id: "acme__widget-1234",
      provenance: {
        kind: "mined",
        sourceCommitment: `sha256:${"2".repeat(64)}`,
        timestamp: "2026-04-12T09:15:00Z",
      },
    },
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
    evaluation: { digest: { sha256: evaluationSpecDigest.slice("sha256:".length) } },
  });
  const taskDigest = prefixedDigest(taskBytes);
  const issuer = "did:jinn:admission-agent";
  const payloadBytes = canonicalJsonBytes({
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "task", digest: { sha256: taskDigest.slice("sha256:".length) } },
      { name: "evaluation-spec", digest: { sha256: evaluationSpecDigest.slice("sha256:".length) } },
    ],
    predicateType: "https://spec.jinn.network/attestations/differential-admission/v3",
    predicate: { issuer },
  });
  const receiptBytes = sealDsseEnvelope({
    payloadType: "application/vnd.in-toto+json",
    payloadBytes,
    signatures: [{ keyid: "admission-key", signature: new Uint8Array([1, 2, 3]) }],
  });
  const entry: LiveSupplyPoolEntry = {
    taskDigest,
    taskBytes,
    evaluationSpecDigest,
    evaluationSpecBytes,
    receiptDigest: prefixedDigest(receiptBytes),
    environmentRecordDigest: `sha256:${"3".repeat(64)}`,
    strategyId: "import.swe-rebench.v1",
    provenance: {
      kind: "mined",
      sourceCommitment: `sha256:${"2".repeat(64)}`,
      upstream: { dataset: "nebius/SWE-rebench", revision: "r1", instanceId: "acme__widget-1234" },
    },
    rights: { sourceLicense: "Apache-2.0" },
  };
  const { taskBytes: _task, evaluationSpecBytes: _spec, ...summary } = entry;
  return { entry, summary, receiptBytes, issuer };
}

function dependencies(overrides: {
  readonly summaries?: readonly LiveSupplyPoolSummary[];
  readonly entry?: LiveSupplyPoolEntry;
  readonly receiptBytes?: Uint8Array;
  readonly verified?: boolean;
} = {}) {
  const value = fixture();
  return {
    value,
    input: {
      pool: {
        list: async () => overrides.summaries ?? [value.summary],
        get: async () => overrides.entry ?? value.entry,
      },
      receipts: { get: async () => overrides.receiptBytes ?? value.receiptBytes },
      receiptVerifier: { verify: vi.fn(async () => overrides.verified ?? true) },
      assessment: { assess: vi.fn(async ({ provenanceTimestamp }: { provenanceTimestamp: string }) => ({
        id: "acme__widget-1234",
        repository: "github.com/acme/widget",
        sourceLineage: [`upstream:${provenanceTimestamp}`],
        workIdentity: "nebius/SWE-rebench/acme__widget-1234",
        tupleClass: "repository-work/1.0",
        compatible: true,
        previouslyAttempted: false,
        contaminated: false,
        scorable: true,
      })) },
    },
  };
}

describe("verified SupplyPool reader", () => {
  test("verifies exact pool bytes, upstream time, DSSE subjects, issuer, and signature", async () => {
    const { input, value } = dependencies();
    const [candidate] = await readVerifiedSupplyPool(input);
    expect(candidate).toMatchObject({
      id: "acme__widget-1234",
      admission: { verified: true, positive: true, receiptDigest: value.entry.receiptDigest },
    });
    expect(input.assessment.assess).toHaveBeenCalledWith(expect.objectContaining({
      provenanceTimestamp: "2026-04-12T09:15:00Z",
      receiptIssuer: value.issuer,
    }));
    expect(input.receiptVerifier.verify).toHaveBeenCalledWith(expect.objectContaining({
      issuer: value.issuer,
      keyId: "admission-key",
      signatureIndex: 0,
    }));
  });

  test("turns byte, receipt, trust, and provenance substitution into malformed exclusions", async () => {
    const base = fixture();
    const badTask = new TextEncoder().encode("not the task");
    const invalidTimestamp = sealTask({
      ...JSON.parse(new TextDecoder().decode(base.entry.taskBytes)),
      payload: { provenance: { timestamp: "2026-08-05T12:00:00" } },
    });
    for (const input of [
      dependencies({ entry: { ...base.entry, taskBytes: badTask } }).input,
      dependencies({ receiptBytes: new TextEncoder().encode("substituted") }).input,
      dependencies({ verified: false }).input,
      dependencies({ entry: {
        ...base.entry,
        taskBytes: invalidTimestamp,
        taskDigest: prefixedDigest(invalidTimestamp),
      }, summaries: [{
        ...base.summary,
        taskDigest: prefixedDigest(invalidTimestamp),
      }] }).input,
    ]) {
      const [candidate] = await readVerifiedSupplyPool(input);
      expect(candidate?.admission.verified).toBe(false);
    }
  });

  test("fails the batch on listing ambiguity or list/get drift", async () => {
    const base = fixture();
    await expect(readVerifiedSupplyPool(dependencies({
      summaries: [base.summary, base.summary],
    }).input)).rejects.toThrow(/ambiguous/u);
    await expect(readVerifiedSupplyPool(dependencies({
      entry: { ...base.entry, strategyId: "changed-between-list-and-get" },
    }).input)).rejects.toThrow(/changed between list and get/u);
  });

  test("normalizes malformed digest spellings into a sealable exclusion", async () => {
    const base = fixture();
    const [candidate] = await readVerifiedSupplyPool(dependencies({
      summaries: [{ ...base.summary, taskDigest: "not-a-digest" }],
    }).input);
    expect(candidate).toMatchObject({ id: "not-a-digest", admission: { verified: false } });
    expect(candidate?.task.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(candidate?.evaluationSpec.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(candidate?.admission.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
