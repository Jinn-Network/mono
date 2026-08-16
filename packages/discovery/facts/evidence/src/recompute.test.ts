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
  executionEvidenceRecompute,
  executionEvidenceRecomputeV2,
  executionVerificationRecompute,
  resultEvaluationRecompute,
  resultEvaluationRecomputeV2,
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
