import { RECORD_KINDS, cloudEventsFields, referenceBearingFields, sealJson } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  executionEvidenceProfile,
  executionVerificationProfile,
  resultEvaluationProfile,
} from "./profiles.js";

// Pinned-digest golden documents (plan Task 22 Step 3, mirroring
// protocol/src/fixtures.test.ts's pinned-digest convention): each facts
// profile is a sealed, digest-pinned document. Update these only when a
// field or key ordering changes deliberately.
const EXPECTED_DIGESTS: Record<string, string> = {
  "execution-evidence": "sha256:c36fb2a8e4fa3dc6216c81bcefd48d1216dce66ec2bd095014d138c30079d86f",
  "result-evaluation": "sha256:d29d2912be95a56c4029b817413a09fe150e146f4520da5ed109f1c3513d9e65",
  "execution-verification": "sha256:1cc7b58b201d4ae8463ab03f8feb17ba4046509cb9a0b42eaf8d6df1c5ed94e1",
};

function expectPinnedDigest(name: string, digest: string) {
  const expected = EXPECTED_DIGESTS[name];
  if (expected === undefined || expected === "sha256:PENDING") {
    throw new Error(
      `No pinned digest for "${name}" yet -- actual digest: ${digest}\n`
        + "Paste this into EXPECTED_DIGESTS and re-run.",
    );
  }
  expect(digest).toBe(expected);
}

describe("facts/evidence profile documents", () => {
  it("execution-evidence profile names the execution-evidence kind and labels every field record-class", () => {
    expect(executionEvidenceProfile.kind).toBe(RECORD_KINDS.executionEvidence);
    expect(executionEvidenceProfile.fields.every((field) => field.class === "record")).toBe(true);
    expect(referenceBearingFields(executionEvidenceProfile)).toEqual(["taskDigest"]);
    expect(cloudEventsFields(executionEvidenceProfile).map((field) => field.name)).toEqual(["executionId", "outcome"]);
    expectPinnedDigest("execution-evidence", sealJson(executionEvidenceProfile).digest);
  });

  it("result-evaluation profile names the result-evaluation kind and labels every field record-class", () => {
    expect(resultEvaluationProfile.kind).toBe(RECORD_KINDS.resultEvaluation);
    expect(resultEvaluationProfile.fields.every((field) => field.class === "record")).toBe(true);
    expect(referenceBearingFields(resultEvaluationProfile)).toEqual(["taskDigest", "resultDigest"]);
    expect(cloudEventsFields(resultEvaluationProfile).map((field) => field.name)).toEqual(["verdict"]);
    expectPinnedDigest("result-evaluation", sealJson(resultEvaluationProfile).digest);
  });

  it("execution-verification profile names the execution-verification kind and labels every field record-class", () => {
    expect(executionVerificationProfile.kind).toBe(RECORD_KINDS.executionVerification);
    expect(executionVerificationProfile.fields.every((field) => field.class === "record")).toBe(true);
    expect(referenceBearingFields(executionVerificationProfile)).toEqual(["subjectDigest"]);
    expect(cloudEventsFields(executionVerificationProfile).map((field) => field.name)).toEqual(["verdict", "executionId"]);
    expectPinnedDigest("execution-verification", sealJson(executionVerificationProfile).digest);
  });

  it("no evidence facts profile declares a substrate field (§5.4: evidence kinds are author/retrospective)", () => {
    for (const profile of [executionEvidenceProfile, resultEvaluationProfile, executionVerificationProfile]) {
      expect(profile.fields.some((field) => field.class === "substrate")).toBe(false);
    }
  });

  it("seals to a stable digest independent of source key order (JCS)", () => {
    const sealed = sealJson(executionEvidenceProfile);
    const shuffled = sealJson({
      protocol: executionEvidenceProfile.protocol,
      fields: executionEvidenceProfile.fields,
      kind: executionEvidenceProfile.kind,
      profile: executionEvidenceProfile.profile,
    });
    expect(shuffled.digest).toBe(sealed.digest);
    expect(sealed.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
