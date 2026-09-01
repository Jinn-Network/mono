import { readFile } from "node:fs/promises";

import { RECORD_KINDS, recordDigest } from "@jinn-network/record-discovery-protocol";
import type { ReferencedBytes } from "@jinn-network/record-discovery-protocol";
import { validateAndProjectEvidenceRecord } from "@jinn-network/evidence-discovery/indexer";
import type {
  ExecutionEvidenceProjection,
  ExecutionVerificationProjection,
  ResultEvaluationProjection,
} from "@jinn-network/evidence-discovery";
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_FACTS_RECOMPUTE,
  EVIDENCE_FACTS_RECOMPUTE_V2,
  EVIDENCE_FACTS_RECOMPUTE_V3,
  executionEvidenceRecompute,
  executionEvidenceRecomputeV2,
  executionEvidenceRecomputeV3,
  executionVerificationRecompute,
  executionVerificationRecomputeV2,
  resultEvaluationRecompute,
  resultEvaluationRecomputeV2,
  resultEvaluationRecomputeV3,
} from "./recompute.js";

const fixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);

const noReferencedBytes: ReferencedBytes = {
  async "fetch"() {
    return undefined;
  },
};

describe("facts/evidence recompute functions", () => {
  it("recomputes execution-evidence record facts straight from the sealed bytes", async () => {
    const bytes = await readFile(new URL("public/ro-crate-metadata.json", fixtureRoot));
    const reference = validateAndProjectEvidenceRecord(
      { family: "execution-evidence", digest: recordDigest(bytes) },
      bytes,
    );
    if (!reference.conforms || reference.projection.family !== "execution-evidence") {
      throw new Error("fixture did not conform to execution-evidence");
    }
    const projection: ExecutionEvidenceProjection = reference.projection;

    const facts = await executionEvidenceRecompute(bytes, noReferencedBytes);
    expect(facts).toEqual({
      executionId: projection.executionId,
      executorId: projection.executorId,
      taskDigest: projection.task.digest,
      outcome: projection.outcome,
      startedAt: projection.startedAt,
      endedAt: projection.endedAt,
      publishedAt: projection.publishedAt,
    });
  });

  it("recomputes result-evaluation record facts straight from the sealed bytes", async () => {
    const bytes = await readFile(
      new URL("claims/result-evaluation/result-evaluation.dsse.json", fixtureRoot),
    );
    const reference = validateAndProjectEvidenceRecord(
      { family: "result-evaluation", digest: recordDigest(bytes) },
      bytes,
    );
    if (!reference.conforms || reference.projection.family !== "result-evaluation") {
      throw new Error("fixture did not conform to result-evaluation");
    }
    const projection: ResultEvaluationProjection = reference.projection;

    const facts = await resultEvaluationRecompute(bytes, noReferencedBytes);
    expect(facts).toEqual({
      evaluatorId: projection.evaluatorId,
      verdict: projection.verdict,
      evaluatedAt: projection.evaluatedAt,
      taskDigest: projection.taskSubject.digest,
      resultDigest: projection.resultSubjects[0].digest,
    });
  });

  it("recomputes v2 execution and evaluation facts with complete Result subject sets", async () => {
    const executionBytes = await readFile(new URL("public/ro-crate-metadata.json", fixtureRoot));
    const evaluationBytes = await readFile(
      new URL("claims/result-evaluation/result-evaluation.dsse.json", fixtureRoot),
    );
    const execution = validateAndProjectEvidenceRecord(
      { family: "execution-evidence", digest: recordDigest(executionBytes) },
      executionBytes,
    );
    const evaluation = validateAndProjectEvidenceRecord(
      { family: "result-evaluation", digest: recordDigest(evaluationBytes) },
      evaluationBytes,
    );
    if (!execution.conforms || execution.projection.family !== "execution-evidence") throw new Error("invalid execution fixture");
    if (!evaluation.conforms || evaluation.projection.family !== "result-evaluation") throw new Error("invalid evaluation fixture");
    await expect(executionEvidenceRecomputeV2(executionBytes, noReferencedBytes)).resolves.toMatchObject({
      runtimeDigest: execution.projection.runtime.digest,
      resultDigests: execution.projection.results.map(({ digest }) => digest),
    });
    await expect(resultEvaluationRecomputeV2(evaluationBytes, noReferencedBytes)).resolves.toMatchObject({
      resultDigests: evaluation.projection.resultSubjects.map(({ digest }) => digest),
    });
    expect(EVIDENCE_FACTS_RECOMPUTE_V2.get(RECORD_KINDS.executionEvidence)).toBe(executionEvidenceRecomputeV2);
  });

  it("recomputes execution-verification record facts straight from the sealed bytes", async () => {
    const bytes = await readFile(
      new URL("claims/execution-verification/execution-verification.dsse.json", fixtureRoot),
    );
    const reference = validateAndProjectEvidenceRecord(
      { family: "execution-verification", digest: recordDigest(bytes) },
      bytes,
    );
    if (!reference.conforms || reference.projection.family !== "execution-verification") {
      throw new Error("fixture did not conform to execution-verification");
    }
    const projection: ExecutionVerificationProjection = reference.projection;

    const facts = await executionVerificationRecompute(bytes, noReferencedBytes);
    expect(facts).toEqual({
      verifierId: projection.verifierId,
      verdict: projection.verdict,
      verifiedAt: projection.verifiedAt,
      executionId: projection.executionId,
      subjectDigest: projection.subjectRecord.digest,
    });
  });

  it("recomputes to no facts for bytes that do not conform -- never silently consistent", async () => {
    const bytes = new TextEncoder().encode("{");
    expect(await executionEvidenceRecompute(bytes, noReferencedBytes)).toEqual({});
    expect(await resultEvaluationRecompute(bytes, noReferencedBytes)).toEqual({});
    expect(await executionVerificationRecompute(bytes, noReferencedBytes)).toEqual({});
  });

  it("the FactsRecompute registry resolves each evidence kind and nothing else", () => {
    expect(EVIDENCE_FACTS_RECOMPUTE.get(RECORD_KINDS.executionEvidence)).toBe(executionEvidenceRecompute);
    expect(EVIDENCE_FACTS_RECOMPUTE.get(RECORD_KINDS.resultEvaluation)).toBe(resultEvaluationRecompute);
    expect(EVIDENCE_FACTS_RECOMPUTE.get(RECORD_KINDS.executionVerification)).toBe(executionVerificationRecompute);
    expect(EVIDENCE_FACTS_RECOMPUTE.get(RECORD_KINDS.task)).toBeUndefined();
  });
});

// A DSSE envelope whose payload carries the lineage the goldens do not. The projector does not
// verify signatures (`project-record.test.ts` pins that), so re-encoding the payload is enough
// to exercise a code path the fixtures cannot reach: neither golden carries `supersedes` or
// `disputes`, so without this both edges would only ever be asserted empty.
function withPredicateFields(
  envelopeBytes: Uint8Array,
  fields: Record<string, unknown>,
): Uint8Array {
  const envelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as {
    payload: string;
    [key: string]: unknown;
  };
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
    predicate: Record<string, unknown>;
  };
  const next = { ...payload, predicate: { ...payload.predicate, ...fields } };
  return new TextEncoder().encode(JSON.stringify({
    ...envelope,
    payload: Buffer.from(JSON.stringify(next), "utf8").toString("base64"),
  }));
}

const descriptor = (name: string, seed: string) => ({
  name,
  digest: { sha256: seed.repeat(64).slice(0, 64) },
});

describe("the next revisions: the join edges the earlier cards left out", () => {
  it("names the native trace an execution pins, keeping every v2 fact", async () => {
    const bytes = await readFile(new URL("public/ro-crate-metadata.json", fixtureRoot));
    const v2 = await executionEvidenceRecomputeV2(bytes, noReferencedBytes);
    // The golden's own trace digest, written out rather than recomputed through the same call
    // the implementation makes: a mapping bug that renamed the field would still pass that.
    expect(await executionEvidenceRecomputeV3(bytes, noReferencedBytes)).toEqual({
      ...v2,
      nativeTraceDigest: "sha256:49db69574d82af9133e1b37ab2c1b28e32067642f9fb92d45b58a789d958ff2a",
    });
  });

  it("names the evaluations an evaluation supersedes and disputes", async () => {
    const golden = await readFile(
      new URL("claims/result-evaluation/result-evaluation.dsse.json", fixtureRoot),
    );
    const superseded = descriptor("prior-evaluation", "1");
    const disputedOne = descriptor("disputed-evaluation-a", "2");
    const disputedTwo = descriptor("disputed-evaluation-b", "3");
    const bytes = withPredicateFields(golden, {
      supersedes: [superseded],
      disputes: [disputedOne, disputedTwo],
    });
    const facts = await resultEvaluationRecomputeV3(bytes, noReferencedBytes);
    expect(facts.supersedesDigests).toEqual([`sha256:${"1".repeat(64)}`]);
    // Record order, so an ordinal in the edge index names the same dispute twice.
    expect(facts.disputesDigests).toEqual([`sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`]);
    expect(facts.verdict).toBe("pass");
  });

  it("states empty lineage lists for an evaluation that supersedes and disputes nothing", async () => {
    const bytes = await readFile(
      new URL("claims/result-evaluation/result-evaluation.dsse.json", fixtureRoot),
    );
    const v2 = await resultEvaluationRecomputeV2(bytes, noReferencedBytes);
    expect(await resultEvaluationRecomputeV3(bytes, noReferencedBytes)).toEqual({
      ...v2,
      supersedesDigests: [],
      disputesDigests: [],
    });
  });

  it("names the same two lineage edges on a verification record", async () => {
    const golden = await readFile(
      new URL("claims/execution-verification/execution-verification.dsse.json", fixtureRoot),
    );
    const bytes = withPredicateFields(golden, {
      supersedes: [descriptor("prior-verification", "4")],
      disputes: [descriptor("disputed-verification", "5")],
    });
    const facts = await executionVerificationRecomputeV2(bytes, noReferencedBytes);
    expect(facts.supersedesDigests).toEqual([`sha256:${"4".repeat(64)}`]);
    expect(facts.disputesDigests).toEqual([`sha256:${"5".repeat(64)}`]);
  });

  it("states empty lineage lists for a verification that supersedes and disputes nothing", async () => {
    const bytes = await readFile(
      new URL("claims/execution-verification/execution-verification.dsse.json", fixtureRoot),
    );
    const v1 = await executionVerificationRecompute(bytes, noReferencedBytes);
    expect(await executionVerificationRecomputeV2(bytes, noReferencedBytes)).toEqual({
      ...v1,
      supersedesDigests: [],
      disputesDigests: [],
    });
  });

  it("recomputes to no facts for bytes that do not conform", async () => {
    const bytes = new TextEncoder().encode("{");
    expect(await executionEvidenceRecomputeV3(bytes, noReferencedBytes)).toEqual({});
    expect(await resultEvaluationRecomputeV3(bytes, noReferencedBytes)).toEqual({});
    expect(await executionVerificationRecomputeV2(bytes, noReferencedBytes)).toEqual({});
  });

  it("registers each evidence kind under its newest revision and nothing else", () => {
    expect(EVIDENCE_FACTS_RECOMPUTE_V3.get(RECORD_KINDS.executionEvidence)).toBe(executionEvidenceRecomputeV3);
    expect(EVIDENCE_FACTS_RECOMPUTE_V3.get(RECORD_KINDS.resultEvaluation)).toBe(resultEvaluationRecomputeV3);
    expect(EVIDENCE_FACTS_RECOMPUTE_V3.get(RECORD_KINDS.executionVerification)).toBe(executionVerificationRecomputeV2);
    expect(EVIDENCE_FACTS_RECOMPUTE_V3.get(RECORD_KINDS.task)).toBeUndefined();
  });
});
