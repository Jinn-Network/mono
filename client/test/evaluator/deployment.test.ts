import { describe, expect, it } from "vitest";
import { createTrustedEvaluatorDeployment } from "../../src/evaluator/deployment.js";

describe("createTrustedEvaluatorDeployment", () => {
  it("is inert until a trusted deployment explicitly supplies evaluator authority and evidence writing", () => {
    const evidenceWriter = {
      putClaimEvidence: async () => ({
        name: "claim-evidence.json",
        digest: { sha256: "1".repeat(64) },
      }),
    };
    const deployment = createTrustedEvaluatorDeployment({
      evaluatorId: "https://agents.example/jinn/evaluator-1",
      signerHandle: "deployment-owned-evaluator-signer",
      evaluationMethod: {
        name: "evaluator-adapters-v1",
        uri: "https://spec.jinn.network/software/evaluator-adapters/v1",
        digest: { sha256: "9".repeat(64) },
      },
      evidenceWriter,
      maxClaimEvidenceBytes: 1024,
    });

    expect(deployment.evidenceWriter).toBe(evidenceWriter);
    expect(deployment.registrations).toHaveLength(2);
  });
});
