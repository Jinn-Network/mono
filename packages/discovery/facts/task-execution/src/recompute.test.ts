import { readFile } from "node:fs/promises";

import { RECORD_KINDS, recordDigest } from "@jinn-network/record-discovery-protocol";
import type { ReferencedBytes } from "@jinn-network/record-discovery-protocol";
import { sealDelivery, sealSubmission, sealTask } from "@jinn-network/task-execution-protocol";
import { sealEvaluationSpec } from "@jinn-network/task-execution-profiles";
import { describe, expect, it } from "vitest";

import {
  TASK_EXECUTION_FACTS_RECOMPUTE,
  TASK_EXECUTION_FACTS_RECOMPUTE_V2,
  checkpointRecompute,
  deliveryRecompute,
  deliveryRecomputeV2,
  taskRecomputeV2,
  evaluationSpecRecompute,
  evaluationSpecRecomputeV2,
  pluginRecompute,
  profileDocumentRecompute,
  profileDocumentRecomputeV2,
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

async function loadStatePredicateSpecBytes(): Promise<Uint8Array> {
  return fixtureBytes(
    "@jinn-network/task-execution-profiles/fixtures/evaluation-spec/golden/state-predicate-minimal.json",
  );
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

describe("v2 recompute: the join edges v1 left out", () => {
  it("states an empty input list for a Task that supplies none, keeping every v1 fact", async () => {
    const bytes = await loadGoldenTaskBytes();
    const v1 = await taskRecompute(bytes, noReferencedBytes);
    expect(await taskRecomputeV2(bytes, noReferencedBytes)).toEqual({ ...v1, inputDigests: [] });
  });

  it("names a Task's digest-pinned inputs and skips the ones that pin nothing", async () => {
    const golden = JSON.parse(new TextDecoder().decode(await loadGoldenTaskBytes())) as Record<string, unknown>;
    const bytes = sealTask({
      ...golden,
      inputs: [
        { name: "seed", digest: { sha256: "d".repeat(64) } },
        { name: "docs", uri: "https://example.test/docs" },
      ],
    });
    const facts = await taskRecomputeV2(bytes, noReferencedBytes);
    expect(facts.inputDigests).toEqual([`sha256:${"d".repeat(64)}`]);
  });

  it("names the outputs a Delivery produced", async () => {
    const bytes = await loadGoldenDeliveryBytes();
    const facts = await deliveryRecomputeV2(bytes, noReferencedBytes);
    expect(facts.resultDigests).toEqual([
      "sha256:dc8231acfaa265ffcb0853fdb6716718e4e75c68f372e73ccea21e7a6f44a0de",
    ]);
    expect(facts.evidenceDigests).toEqual([]);
    expect(facts).not.toHaveProperty("supersedesDigest");
  });

  it("names the evidence records and the Delivery it replaces", async () => {
    const bytes = sealDelivery({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
      task: `sha256:${"1".repeat(64)}`,
      outputs: [],
      outcome: "fulfilled",
      evidenceRecords: [{ family: "execution-evidence", digest: `sha256:${"2".repeat(64)}` }],
      supersedes: `sha256:${"3".repeat(64)}`,
      createdAt: "2026-08-01T00:05:00Z",
    });
    const facts = await deliveryRecomputeV2(bytes, noReferencedBytes);
    expect(facts.evidenceDigests).toEqual([`sha256:${"2".repeat(64)}`]);
    expect(facts.supersedesDigest).toBe(`sha256:${"3".repeat(64)}`);
  });

  it("emits no facts for bytes that are not the record kind", async () => {
    const junk = new TextEncoder().encode("not json at all");
    expect(await taskRecomputeV2(junk, noReferencedBytes)).toEqual({});
    expect(await deliveryRecomputeV2(junk, noReferencedBytes)).toEqual({});
  });

  it("names an evaluation spec's graders and the components its family block pins", async () => {
    const bytes = await loadSweRebenchEvaluationSpecBytes();
    const facts = await evaluationSpecRecomputeV2(bytes, noReferencedBytes);
    expect(facts).toEqual({
      family: "deterministic-process",
      graderDigests: ["sha256:d2136b44c86f551b2494d616a8ee7afd58e6f90681f1beb84441113154a13897"],
      imageDigest: "sha256:e8d6cfe4f52e87a1292f3897bf0bea28e4bde32703e6792bb9b1bc60d3024817",
      parserDigest: "sha256:d2136b44c86f551b2494d616a8ee7afd58e6f90681f1beb84441113154a13897",
      // The golden's one test-material entry is uri-only, so it pins nothing and is no edge.
      testMaterialDigests: [],
    });
    expect(facts).not.toHaveProperty("environmentRecordDigest");
    expect(facts).not.toHaveProperty("rubricDigest");
    expect(facts).not.toHaveProperty("abiRefDigests");
  });

  it("names the ABIs a state-predicate spec reads through, from both call sites, de-duplicated", async () => {
    const abi = "e".repeat(64);
    const otherAbi = "f".repeat(64);
    const call = (digest: string) => ({
      abiRef: { digest: { sha256: digest } },
      function: "balanceOf(address)",
      args: [{ type: "address", value: `0x${"1".repeat(40)}` }],
    });
    // The profiles package's own golden, with declarative call targets added: two predicates
    // reading through one ABI, a third through another, and a fourth whose target is an encoded
    // call and so names no ABI at all.
    const golden = JSON.parse(
      new TextDecoder().decode(await loadStatePredicateSpecBytes()),
    ) as Record<string, unknown>;
    const block = golden.familyBlock as Record<string, unknown>;
    const spec = {
      ...golden,
      familyBlock: {
        ...block,
        successPredicates: [
          ...(block.successPredicates as unknown[]),
          { kind: "callResult", to: `0x${"2".repeat(40)}`, call: call(abi), decode: "uint256", cmp: "eq", value: "1" },
          { kind: "reportedValue", name: "reported", cmp: "eq", value: "1", groundTruth: { to: `0x${"3".repeat(40)}`, call: call(abi), decode: "uint256" } },
          { kind: "callResult", to: `0x${"4".repeat(40)}`, call: call(otherAbi), decode: "uint256", cmp: "eq", value: "1" },
          { kind: "callResult", to: `0x${"5".repeat(40)}`, call: { encodedCall: "0xabcdef" }, decode: "uint256", cmp: "eq", value: "1" },
        ],
      },
    };
    const facts = await evaluationSpecRecomputeV2(sealEvaluationSpec(spec as never).bytes, noReferencedBytes);
    expect(facts.abiRefDigests).toEqual([`sha256:${abi}`, `sha256:${otherAbi}`]);
    expect(facts.environmentRecordDigest).toBe(`sha256:${"a".repeat(64)}`);
    // The golden's grader is uri-only, so it pins nothing and contributes no edge.
    expect(facts.graderDigests).toEqual([]);
  });

  it("reads every list that can carry an ABI: a safety constraint cannot, and the schema says so", async () => {
    // The completeness claim rests on successPredicates being the only reachable call site, so
    // pin it against the schema rather than against a reading of it: a call-bearing predicate is
    // not a legal safety constraint, and a spec that puts one there does not seal at all.
    const golden = JSON.parse(
      new TextDecoder().decode(await loadStatePredicateSpecBytes()),
    ) as Record<string, unknown>;
    const block = golden.familyBlock as Record<string, unknown>;
    expect(() => sealEvaluationSpec({
      ...golden,
      familyBlock: {
        ...block,
        safetyConstraints: [{
          kind: "callResult",
          to: `0x${"2".repeat(40)}`,
          call: {
            abiRef: { digest: { sha256: "e".repeat(64) } },
            function: "balanceOf(address)",
            args: [{ type: "address", value: `0x${"1".repeat(40)}` }],
          },
          decode: "uint256",
          cmp: "eq",
          value: "1",
        }],
      },
      // Bound to the actual refusal, so a golden that drifts cannot keep this green by
      // failing for some other reason.
    } as never)).toThrow(/safetyConstraints are bounded to log- and transaction-observable kinds/);
  });

  it("names the output-slot schemas a profile pins, skipping slots that pin nothing", async () => {
    const bytes = await loadRepositoryWorkProfileBytes();
    const document = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const slots = (document.outputConventions as { slots: Record<string, unknown>[] }).slots;
    // The published profile's three slots carry no schema at all, so v2's card states an empty
    // list — a true recomputed statement, not an omission.
    expect((await profileDocumentRecomputeV2(bytes, noReferencedBytes)).outputSlotSchemaDigests).toEqual([]);

    // Give two of them a schema: one digest-pinned, one satisfied by a uri alone. Only the
    // first is an edge (§6.4), which is the same line the evaluation-spec card draws.
    const withSchemas = new TextEncoder().encode(JSON.stringify({
      ...document,
      outputConventions: {
        slots: [
          { ...slots[0], schema: { name: "patch-schema", digest: { sha256: "a".repeat(64) } } },
          { ...slots[1], schema: { name: "summary-schema", uri: "https://example.test/summary.json" } },
          slots[2],
        ],
      },
    }));
    const facts = await profileDocumentRecomputeV2(withSchemas, noReferencedBytes);
    expect(facts.outputSlotSchemaDigests).toEqual([`sha256:${"a".repeat(64)}`]);
    expect(facts.profile).toBe(document.profile);
  });

  it("emits no facts for bytes that are not an evaluation spec or a profile document", async () => {
    expect(await evaluationSpecRecomputeV2(new TextEncoder().encode("{"), noReferencedBytes)).toEqual({});
    expect(await profileDocumentRecomputeV2(new TextEncoder().encode("{"), noReferencedBytes)).toEqual({});
  });

  it("routes the four revised kinds to v2 and every other kind to its unrevised fn", () => {
    expect(TASK_EXECUTION_FACTS_RECOMPUTE_V2.get(RECORD_KINDS.task)).toBe(taskRecomputeV2);
    expect(TASK_EXECUTION_FACTS_RECOMPUTE_V2.get(RECORD_KINDS.delivery)).toBe(deliveryRecomputeV2);
    expect(TASK_EXECUTION_FACTS_RECOMPUTE_V2.get(RECORD_KINDS.evaluationSpec)).toBe(evaluationSpecRecomputeV2);
    expect(TASK_EXECUTION_FACTS_RECOMPUTE_V2.get(RECORD_KINDS.profileDocument)).toBe(profileDocumentRecomputeV2);
    expect(TASK_EXECUTION_FACTS_RECOMPUTE_V2.get(RECORD_KINDS.submission)).toBe(
      TASK_EXECUTION_FACTS_RECOMPUTE.get(RECORD_KINDS.submission),
    );
    expect(TASK_EXECUTION_FACTS_RECOMPUTE_V2.get("https://spec.jinn.network/records/nope/v1")).toBeUndefined();
  });
});
