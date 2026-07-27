// SPDX-License-Identifier: Apache-2.0

import {
  validateExecutionVerification,
  validateResultEvaluation,
  verifyDsseSignatures,
  type DsseSignatureVerifier,
} from "@jinn-network/evidence-protocol";
import type { EvidenceRepository } from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import type {
  AnyPreparedAttestation,
  AttestationResourceReference,
  AttestationCommitReceipt,
  PrepareExecutionVerificationInput,
  PreparedExecutionVerification,
  PreparedResultEvaluation,
  PrepareResultEvaluationInput,
} from "./index.js";

export interface AttestationIssuerContractObservation<
  TPrepared extends AnyPreparedAttestation,
> {
  readonly prepared: TPrepared;
  readonly receipt: AttestationCommitReceipt<TPrepared["family"]>;
  readonly repository: EvidenceRepository;
  readonly signatureVerifier: DsseSignatureVerifier;
  readonly cleanup?: () => Promise<void> | void;
}

export interface AttestationIssuerContractDriver {
  issueResultEvaluation(
    input: PrepareResultEvaluationInput,
  ): Promise<AttestationIssuerContractObservation<PreparedResultEvaluation>>;
  issueExecutionVerification(
    input: PrepareExecutionVerificationInput,
  ): Promise<AttestationIssuerContractObservation<PreparedExecutionVerification>>;
}

export type AttestationIssuerContractDriverFactory = () =>
  | AttestationIssuerContractDriver
  | Promise<AttestationIssuerContractDriver>;

const a = `sha256:${"a".repeat(64)}` as const;
const b = `sha256:${"b".repeat(64)}` as const;

function expectedDescriptor(reference: AttestationResourceReference) {
  return {
    ...reference.extensions,
    name: reference.name,
    digest: { sha256: reference.digest.slice("sha256:".length) },
    ...(reference.uri === undefined ? {} : { uri: reference.uri }),
    ...(reference.mediaType === undefined ? {} : { mediaType: reference.mediaType }),
    ...(reference.annotations === undefined
      ? {}
      : { annotations: reference.annotations }),
  };
}

const minimalEvaluation: PrepareResultEvaluationInput = {
  task: { name: "task.md", digest: a },
  results: [{ name: "result.patch", digest: b }],
  evaluator: { id: "https://example.test/agents/evaluator" },
  evaluatedAt: "2026-07-24T12:00:00Z",
  verdict: "pass",
};

const fullEvaluation: PrepareResultEvaluationInput = {
  ...minimalEvaluation,
  task: {
    name: "task.md",
    digest: a,
    uri: "https://example.test/resources/task.md",
    mediaType: "text/markdown",
    annotations: { contractAnnotation: "task" },
    extensions: { contractResource: "task" },
  },
  results: [{
    name: "result.patch",
    digest: b,
    uri: "https://example.test/resources/result.patch",
    mediaType: "text/x-diff",
    annotations: { contractAnnotation: "result" },
    extensions: { contractResource: "result" },
  }],
  evaluator: {
    id: "https://example.test/agents/evaluator",
    extensions: { role: "contract-evaluator" },
  },
  verdict: "inconclusive",
  evaluationSpecification: {
    name: "rubric.json",
    digest: a,
    uri: "https://example.test/resources/rubric.json",
    mediaType: "application/json",
    annotations: { contractAnnotation: "specification" },
    extensions: { contractResource: "specification" },
  },
  evaluationMethod: {
    name: "method.md",
    digest: b,
    uri: "https://example.test/resources/evaluation-method.md",
    mediaType: "text/markdown",
    annotations: { contractAnnotation: "method" },
    extensions: { contractResource: "method" },
  },
  measurements: [{
    name: "score",
    value: 0.75,
    unit: "ratio",
    annotations: { contractAnnotation: "measurement" },
    extensions: { contractMeasurement: true },
  }],
  evidence: [{
    name: "report.json",
    digest: a,
    uri: "https://example.test/resources/evaluation-report.json",
    mediaType: "application/json",
    annotations: { contractAnnotation: "evidence" },
    extensions: { contractResource: "evidence" },
  }],
  explanation: "Synthetic integration-contract observation.",
  limitations: ["No trust conclusion is implied."],
  supersedes: [{
    name: "earlier-evaluation.json",
    digest: b,
    uri: "https://example.test/resources/earlier-evaluation.json",
    mediaType: "application/json",
    annotations: { contractAnnotation: "supersedes" },
    extensions: { contractResource: "supersedes" },
  }],
  disputes: [{
    name: "dispute.json",
    digest: a,
    uri: "https://example.test/resources/evaluation-dispute.json",
    mediaType: "application/json",
    annotations: { contractAnnotation: "disputes" },
    extensions: { contractResource: "disputes" },
  }],
  statementExtensions: { contractStatement: true },
  predicateExtensions: { contractPredicate: true },
};

const minimalVerification: PrepareExecutionVerificationInput = {
  executionEvidenceDigest: a,
  executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  verifier: { id: "https://example.test/agents/verifier" },
  verifiedAt: "2026-07-24T12:01:00Z",
  verdict: "verified",
};

const fullVerification: PrepareExecutionVerificationInput = {
  ...minimalVerification,
  verifier: {
    id: "https://example.test/agents/verifier",
    extensions: { role: "contract-verifier" },
  },
  verdict: "inconclusive",
  verificationPolicy: {
    name: "policy.json",
    digest: a,
    uri: "https://example.test/resources/policy.json",
    mediaType: "application/json",
    annotations: { contractAnnotation: "policy" },
    extensions: { contractResource: "policy" },
  },
  verificationMethod: {
    name: "method.md",
    digest: b,
    uri: "https://example.test/resources/verification-method.md",
    mediaType: "text/markdown",
    annotations: { contractAnnotation: "method" },
    extensions: { contractResource: "method" },
  },
  checks: [{
    name: "trace-integrity",
    status: "unknown",
    explanation: "Synthetic check.",
    evidence: [{
      name: "trace.jsonl",
      digest: b,
      uri: "https://example.test/resources/trace.jsonl",
      mediaType: "application/x-ndjson",
      annotations: { contractAnnotation: "check-evidence" },
      extensions: { contractResource: "check-evidence" },
    }],
    annotations: { contractAnnotation: "check" },
    extensions: { contractCheck: true },
  }],
  explanation: "Synthetic integration-contract observation.",
  limitations: ["No identity conclusion is implied."],
  supersedes: [{
    name: "earlier-verification.json",
    digest: b,
    uri: "https://example.test/resources/earlier-verification.json",
    mediaType: "application/json",
    annotations: { contractAnnotation: "supersedes" },
    extensions: { contractResource: "supersedes" },
  }],
  disputes: [{
    name: "dispute.json",
    digest: a,
    uri: "https://example.test/resources/verification-dispute.json",
    mediaType: "application/json",
    annotations: { contractAnnotation: "disputes" },
    extensions: { contractResource: "disputes" },
  }],
  statementExtensions: { contractStatement: true },
  predicateExtensions: { contractPredicate: true },
};

async function observe<TPrepared extends AnyPreparedAttestation>(
  observation: AttestationIssuerContractObservation<TPrepared>,
  expectedFamily: TPrepared["family"],
): Promise<TPrepared["value"]["statement"]> {
  expect(observation.prepared.family).toBe(expectedFamily);
  expect(observation.receipt).toMatchObject({
    family: expectedFamily,
    recordDigest: observation.prepared.recordDigest,
    repositoryReceipt: {
      reference: {
        family: expectedFamily,
        digest: observation.prepared.recordDigest,
      },
      size: observation.prepared.envelopeBytes.byteLength,
    },
  });
  const retrieved = await observation.repository.getRecord(
    observation.receipt.repositoryReceipt.reference,
  );
  expect(retrieved).toEqual(observation.prepared.envelopeBytes);
  expect(retrieved).not.toBeNull();
  const report = expectedFamily === "result-evaluation"
    ? validateResultEvaluation(retrieved!)
    : validateExecutionVerification(retrieved!);
  expect(report.conforms, JSON.stringify(report.diagnostics)).toBe(true);
  expect(report.recordDigest).toBe(observation.prepared.recordDigest);
  expect(report.value).toBeDefined();
  const signatures = await verifyDsseSignatures(
    report.value!,
    observation.signatureVerifier,
  );
  expect(signatures.verified).toBe(true);
  expect(signatures.signatures.every(({ verified }) => verified)).toBe(true);
  return report.value!.statement as TPrepared["value"]["statement"];
}

export function describeAttestationIssuerIntegrationContract(
  driverFactory: AttestationIssuerContractDriverFactory,
): void {
  describe("Attestation Issuer integration contract", () => {
    test.each([
      ["minimal", minimalEvaluation],
      ["fully populated", fullEvaluation],
    ] as const)("issues %s Result Evaluation Evidence", async (_name, input) => {
      const expected = structuredClone(input);
      const driver = await driverFactory();
      const observation = await driver.issueResultEvaluation(input);
      try {
      const statement = await observe(observation, "result-evaluation");
      const predicate = statement.predicate;
      expect(predicate.evaluator).toEqual({
        ...expected.evaluator.extensions,
        id: expected.evaluator.id,
      });
      expect(statement.subject).toEqual([
        expectedDescriptor(expected.task),
        ...expected.results.map(expectedDescriptor),
      ]);
      expect(predicate).toMatchObject({
        evaluator: { id: expected.evaluator.id },
        evaluatedAt: expected.evaluatedAt,
        verdict: expected.verdict,
      });
      expect(predicate.taskSubject).toBe(expected.task.name);
      expect(predicate.resultSubjects).toEqual(
        expected.results.map(({ name }) => name),
      );
      if (_name === "fully populated") {
        expect(predicate.evaluationSpecification).toEqual(
          expectedDescriptor(expected.evaluationSpecification!),
        );
        expect(predicate.evaluationMethod).toEqual(
          expectedDescriptor(expected.evaluationMethod!),
        );
        expect(predicate.measurements).toEqual(expected.measurements!.map((measurement) => ({
          ...measurement.extensions,
          name: measurement.name,
          value: measurement.value,
          ...(measurement.unit === undefined ? {} : { unit: measurement.unit }),
          ...(measurement.annotations === undefined
            ? {}
            : { annotations: measurement.annotations }),
        })));
        expect(predicate.evidence).toEqual(expected.evidence!.map(expectedDescriptor));
        expect(predicate.supersedes).toEqual(expected.supersedes!.map(expectedDescriptor));
        expect(predicate.disputes).toEqual(expected.disputes!.map(expectedDescriptor));
        expect(predicate.explanation).toBe(expected.explanation);
        expect(predicate.limitations).toEqual(expected.limitations);
        expect(statement).toMatchObject({
          contractStatement: true,
          predicate: {
            contractPredicate: true,
            evaluator: {
              id: expected.evaluator.id,
              role: "contract-evaluator",
            },
            evaluationSpecification: {
              name: "rubric.json",
              contractResource: "specification",
            },
            evaluationMethod: {
              name: "method.md",
              contractResource: "method",
            },
            measurements: [{
              name: "score",
              value: 0.75,
              unit: "ratio",
              contractMeasurement: true,
            }],
            evidence: [{
              name: "report.json",
              contractResource: "evidence",
            }],
            explanation: "Synthetic integration-contract observation.",
            limitations: ["No trust conclusion is implied."],
            supersedes: [{ name: "earlier-evaluation.json" }],
            disputes: [{ name: "dispute.json" }],
          },
        });
      }
      } finally {
        await observation.cleanup?.();
      }
    });

    test.each([
      ["minimal", minimalVerification],
      ["fully populated", fullVerification],
    ] as const)("issues %s Execution Verification Evidence", async (_name, input) => {
      const expected = structuredClone(input);
      const driver = await driverFactory();
      const observation = await driver.issueExecutionVerification(input);
      try {
      const statement = await observe(observation, "execution-verification");
      expect(statement.subject).toEqual([{
        name: "ro-crate-metadata.json",
        digest: { sha256: expected.executionEvidenceDigest.slice("sha256:".length) },
      }]);
      expect(statement.predicate).toMatchObject({
        executionId: expected.executionId,
        verifier: { id: expected.verifier.id },
        verifiedAt: expected.verifiedAt,
        verdict: expected.verdict,
      });
      expect(statement.predicate.verifier).toEqual({
        ...expected.verifier.extensions,
        id: expected.verifier.id,
      });
      if (_name === "fully populated") {
        const fullPredicate = statement.predicate;
        expect(fullPredicate.verificationPolicy).toEqual(
          expectedDescriptor(expected.verificationPolicy!),
        );
        expect(fullPredicate.verificationMethod).toEqual(
          expectedDescriptor(expected.verificationMethod!),
        );
        expect(fullPredicate.checks).toEqual(expected.checks!.map((check) => ({
          ...check.extensions,
          name: check.name,
          status: check.status,
          ...(check.explanation === undefined ? {} : { explanation: check.explanation }),
          ...(check.evidence === undefined
            ? {}
            : { evidence: check.evidence.map(expectedDescriptor) }),
          ...(check.annotations === undefined
            ? {}
            : { annotations: check.annotations }),
        })));
        expect(fullPredicate.supersedes).toEqual(
          expected.supersedes!.map(expectedDescriptor),
        );
        expect(fullPredicate.disputes).toEqual(
          expected.disputes!.map(expectedDescriptor),
        );
        expect(fullPredicate.explanation).toBe(expected.explanation);
        expect(fullPredicate.limitations).toEqual(expected.limitations);
        expect(statement).toMatchObject({
          contractStatement: true,
          predicate: {
            contractPredicate: true,
            verifier: {
              id: expected.verifier.id,
              role: "contract-verifier",
            },
            verificationPolicy: {
              name: "policy.json",
              contractResource: "policy",
            },
            verificationMethod: {
              name: "method.md",
              contractResource: "method",
            },
            checks: [{
              name: "trace-integrity",
              status: "unknown",
              explanation: "Synthetic check.",
              evidence: [{
                name: "trace.jsonl",
                contractResource: "check-evidence",
              }],
              contractCheck: true,
            }],
            explanation: "Synthetic integration-contract observation.",
            limitations: ["No identity conclusion is implied."],
            supersedes: [{ name: "earlier-verification.json" }],
            disputes: [{ name: "dispute.json" }],
          },
        });
      }
      } finally {
        await observation.cleanup?.();
      }
    });
  });
}
