// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { binaryJudgmentEvaluationMethodDescriptor } from "./binary-judgment/adapter.js";
import { createEvaluatorDeployment } from "./deployment.js";
import { BINARY_JUDGMENT_REGISTRATION_ID } from "./registrations.js";

const evidenceWriter = {
  async putClaimEvidence() {
    return { name: "claim-evidence.json", digest: { sha256: "1".repeat(64) } };
  },
};

const config = {
  evaluatorId: "https://agents.example/jinn/evaluator-1",
  signerHandle: "deployment-owned-evaluator-signer",
  evaluationMethod: {
    name: "evaluator-adapters-v1",
    uri: "https://spec.jinn.network/software/evaluator-adapters/v1",
    digest: { sha256: "9".repeat(64) },
  },
  evidenceWriter,
  maxClaimEvidenceBytes: 4 * 1024 * 1024,
};

describe("createEvaluatorDeployment", () => {
  test("uses the trusted deployment's identity, method, evidence writer, parser allowlist, and limit", () => {
    const deployment = createEvaluatorDeployment(config);

    expect(deployment.evidenceWriter).toBe(evidenceWriter);
    expect(deployment.maxClaimEvidenceBytes).toBe(config.maxClaimEvidenceBytes);
    expect(deployment.parserAllowlist.size).toBeGreaterThan(0);
    expect(deployment.registrations).toHaveLength(3);
    expect(deployment.registrations.every((registration) =>
      registration.evaluatorIdentity.id === config.evaluatorId
      && registration.signer.handle === config.signerHandle,
    )).toBe(true);
    const binary = deployment.registrations.find(
      ({ registrationId }) => registrationId === BINARY_JUDGMENT_REGISTRATION_ID,
    );
    expect(binary?.evaluationMethod).toEqual(binaryJudgmentEvaluationMethodDescriptor());
    expect(deployment.registrations
      .filter(({ registrationId }) => registrationId !== BINARY_JUDGMENT_REGISTRATION_ID)
      .every(({ evaluationMethod }) => evaluationMethod === config.evaluationMethod))
      .toBe(true);
  });

  test("refuses a deployment that omits the caller-owned evaluator identity", () => {
    expect(() => createEvaluatorDeployment({ ...config, evaluatorId: "" }))
      .toThrow(/evaluatorId/u);
  });
});
