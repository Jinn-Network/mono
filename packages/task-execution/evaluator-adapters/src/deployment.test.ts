// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { createEvaluatorDeployment } from "./deployment.js";

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
    uri: "https://jinn.network/software/evaluator-adapters/v1",
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
    expect(deployment.registrations).toHaveLength(2);
    expect(deployment.registrations.every((registration) =>
      registration.evaluatorIdentity.id === config.evaluatorId
      && registration.signer.handle === config.signerHandle
      && registration.evaluationMethod === config.evaluationMethod,
    )).toBe(true);
  });

  test("refuses a deployment that omits the caller-owned evaluator identity", () => {
    expect(() => createEvaluatorDeployment({ ...config, evaluatorId: "" }))
      .toThrow(/evaluatorId/u);
  });
});
