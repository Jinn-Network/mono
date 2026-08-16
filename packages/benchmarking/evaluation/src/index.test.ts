// SPDX-License-Identifier: Apache-2.0

import type { DsseSigner } from "@jinn-network/attestation-issuer";
import {
  NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,
  type EvidenceArtifactReference,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type RepositoryWriteReceipt,
} from "@jinn-network/evidence-repository";
import { recordDigest, validateResultEvaluation } from "@jinn-network/evidence-protocol";
import { parseExactDsseEnvelope } from "@jinn-network/trust-core";
import { expect, test } from "vitest";

import {
  issueAuthoritativeLabelResolution,
  issueHumanLabelResolution,
  issueHumanResultEvaluation,
  issueResultEvaluation,
} from "./index.js";

function labelStore(records: Map<string, Uint8Array>) {
  return {
    put: async (bytes: Uint8Array) => {
      const digest = recordDigest(bytes);
      records.set(digest, bytes);
      return {
        reference: {
          family: "human-label-resolution" as const,
          record: {
            name: "human-label-resolution.dsse.json",
            digest: { sha256: digest.slice(7) },
            mediaType: "application/vnd.dsse.envelope.v1+json",
          },
        },
      };
    },
  };
}

class Repository implements EvidenceRepository {
  readonly capabilities = NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES;
  readonly records = new Map<string, Uint8Array>();
  async putRecord(family: EvidenceRecordFamily, bytes: Uint8Array): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
    const digest = recordDigest(bytes);
    const key = `${family}\u0000${digest}`;
    const existing = this.records.has(key);
    this.records.set(key, bytes);
    return { reference: { family, digest }, size: bytes.byteLength, status: existing ? "existing" : "created" };
  }
  async getRecord(reference: EvidenceRecordReference): Promise<Uint8Array | null> {
    return this.records.get(`${reference.family}\u0000${reference.digest}`) ?? null;
  }
  async putArtifact(bytes: Uint8Array): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
    return { reference: { digest: recordDigest(bytes) }, size: bytes.byteLength, status: "created" };
  }
  async getArtifact(): Promise<Uint8Array | null> { return null; }
}

test("issues a judge opinion over original Task+Result with evaluator execution provenance and no Attempt", async () => {
  const repository = new Repository();
  const signer: DsseSigner = async () => [{ keyid: "urn:key:judge-a", signature: Uint8Array.of(1, 2, 3) }];
  const issued = await issueResultEvaluation({
    task: { name: "memory-task.json", digest: `sha256:${"1".repeat(64)}` },
    results: [{ name: "candidate.txt", digest: `sha256:${"2".repeat(64)}` }],
    evaluator: { id: "urn:evaluator:instrument-a" },
    evaluatedAt: "2026-08-16T10:00:00Z",
    verdict: "pass",
    evaluationMethod: { name: "instrument-a.json", digest: `sha256:${"3".repeat(64)}` },
    measurements: [{ name: "binary-opinion", value: "ACCEPT" }],
    supportingEvaluatorExecution: {
      family: "execution-evidence",
      digest: `sha256:${"4".repeat(64)}`,
    },
  }, { signer, repository });

  expect(issued.reference).toMatchObject({ family: "result-evaluation" });
  const report = validateResultEvaluation(issued.prepared.envelopeBytes);
  expect(report).toMatchObject({ conforms: true, diagnostics: [] });
  expect(report.value?.statement.predicate).toMatchObject({
    taskSubject: "memory-task.json",
    resultSubjects: ["candidate.txt"],
    evaluator: { id: "urn:evaluator:instrument-a" },
    verdict: "pass",
    evidence: [{
      name: "ro-crate-metadata.json",
      digest: { sha256: "4".repeat(64) },
    }],
  });
  expect(new TextDecoder().decode(issued.prepared.payloadBytes)).not.toMatch(/Attempt|Submission|Delivery/u);
});

test("preserves two human claims and derives a separately signed unanimous label", async () => {
  const repository = new Repository();
  const signer: DsseSigner = async () => [{ keyid: "urn:key:human", signature: Uint8Array.of(4, 5, 6) }];
  const task = { name: "memory-task.json", digest: `sha256:${"a".repeat(64)}` as const };
  const result = { name: "candidate.txt", digest: `sha256:${"b".repeat(64)}` as const };
  const spec = { name: "two-human-review.json", digest: `sha256:${"c".repeat(64)}` as const };
  const reviews = [];
  for (const [reviewer, suffix] of [["urn:reviewer:alice", "1"], ["urn:reviewer:bob", "2"]] as const) {
    reviews.push(await issueHumanResultEvaluation({
      task,
      results: [result],
      reviewer: { id: reviewer },
      completedAt: `2026-08-16T10:00:0${suffix}Z`,
      opinion: "ACCEPT",
      evaluationSpecification: spec,
      response: { name: `${reviewer}-response.json`, digest: `sha256:${suffix.repeat(64)}` },
      blindVisibilityReceipt: { name: `${reviewer}-visibility.json`, digest: `sha256:${"d".repeat(63)}${suffix}` },
    }, { signer, repository }));
  }
  expect(reviews).toHaveLength(2);
  for (const review of reviews) {
    const validated = validateResultEvaluation(review.prepared.envelopeBytes);
    expect(validated.value?.statement.predicate).toMatchObject({
      taskSubject: task.name,
      resultSubjects: [result.name],
      measurements: expect.arrayContaining([
        { name: "humanLabel", value: "ACCEPT" },
        { name: "blindIndependentReview", value: true },
      ]),
    });
  }

  const resolutions = new Map<string, Uint8Array>();
  const resolution = await issueHumanLabelResolution({
    task: { name: task.name, digest: { sha256: task.digest.slice(7) } },
    results: [{ name: result.name, digest: { sha256: result.digest.slice(7) } }],
    evaluationReferences: reviews.map(({ reference }) => reference),
    policy: {
      id: "https://spec.jinn.network/policies/two-human-unanimity/v1",
      version: "1.0.0",
      requiredReviewers: 2,
      agreement: "unanimous",
    },
    admittingOperator: "urn:operator:admission",
    publisher: "urn:publisher:colophon",
    issuer: "urn:issuer:label-resolution",
    resolvedAt: "2026-08-16T10:01:00Z",
  }, {
    signer,
    evaluations: {
      resolve: async (reference) => repository.getRecord({
        family: "result-evaluation",
        digest: `sha256:${reference.record.digest.sha256}`,
      }),
    },
    store: labelStore(resolutions),
  });
  expect(resolution.payload).toMatchObject({
    resolution: { status: "admitted", label: "ACCEPT" },
    basis: { reviewers: ["urn:reviewer:alice", "urn:reviewer:bob"] },
  });
  expect(parseExactDsseEnvelope(resolution.envelopeBytes).payloadBytes).toEqual(resolution.payloadBytes);
  expect(resolutions.has(`sha256:${resolution.reference.record.digest.sha256}`)).toBe(true);
});

test("admits an authoritative imported label without inventing a human evaluation", async () => {
  const records = new Map<string, Uint8Array>();
  const signer: DsseSigner = async () => [{ keyid: "urn:key:authority-admission", signature: Uint8Array.of(7, 8, 9) }];
  const issued = await issueAuthoritativeLabelResolution({
    task: { name: "memory-task.json", digest: { sha256: "a".repeat(64) } },
    results: [{ name: "candidate.txt", digest: { sha256: "b".repeat(64) } }],
    policy: {
      id: "https://spec.jinn.network/policies/authoritative-label-import/v1",
      version: "1.0.0",
      requiredReviewers: 1,
      agreement: "unanimous",
    },
    authority: "urn:authority:memory-benchmark",
    source: { name: "authoritative-label.json", digest: { sha256: "c".repeat(64) } },
    label: "REJECT",
    admittingOperator: "urn:operator:admission",
    publisher: "urn:publisher:colophon",
    issuer: "urn:issuer:label-resolution",
    resolvedAt: "2026-08-16T10:02:00Z",
  }, { signer, store: labelStore(records) });

  expect(issued.payload).toMatchObject({
    basis: { kind: "authoritative-label-import", authority: "urn:authority:memory-benchmark" },
    resolution: { status: "admitted", label: "REJECT" },
  });
  expect(issued.payload.basis).not.toHaveProperty("evaluations");
  expect(records.size).toBe(1);
});
