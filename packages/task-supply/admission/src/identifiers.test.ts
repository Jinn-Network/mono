import { describe, expect, it } from "vitest";
import {
  ADMISSION_RECEIPT_ANNOTATION_URI,
  ADMISSION_RECEIPT_DESCRIPTOR_NAME,
  ADMISSION_RECEIPT_MEDIA_TYPE,
  ADMISSION_RECEIPT_SCHEMA_VERSION,
  DIFFERENTIAL_ADMISSION_POLICY_V3,
  DIFFERENTIAL_ADMISSION_PREDICATE_TYPE,
  ENVIRONMENT_RECORD_SPEC_KEY,
} from "./identifiers.js";

describe("identifiers", () => {
  it("pins the Submission annotation contract the marketplace evaluation leg validates", () => {
    // Byte-identical counterparts in packages/marketplace/binding/src/evaluation-derive.ts
    // (ADMISSION_RECEIPT_ANNOTATION_URI) and its `receipt.name !== "admission-receipt"` check.
    // That tree is outside this package's import boundary, so the strings are pinned, not shared.
    expect(ADMISSION_RECEIPT_ANNOTATION_URI).toBe(
      "https://jinn.network/annotations/admission-receipt/1.0",
    );
    expect(ADMISSION_RECEIPT_DESCRIPTOR_NAME).toBe("admission-receipt");
  });

  it("seals under the in-toto DSSE payload type the verdict gate requires", () => {
    // packages/marketplace/binding/src/named-checks.ts rejects an admission receipt whose
    // envelope payloadType is not VERDICT_DSSE_PAYLOAD_TYPE
    // (packages/task-execution/profiles/src/identifiers.ts = "application/vnd.in-toto+json").
    expect(ADMISSION_RECEIPT_MEDIA_TYPE).toBe("application/vnd.in-toto+json");
  });

  it("names the receipt kind and policy under jinn.network URIs", () => {
    expect(ADMISSION_RECEIPT_SCHEMA_VERSION).toBe(
      "https://jinn.network/records/differential-admission-receipt/3",
    );
    expect(DIFFERENTIAL_ADMISSION_PREDICATE_TYPE).toBe(
      "https://jinn.network/attestations/differential-admission/v3",
    );
    expect(DIFFERENTIAL_ADMISSION_POLICY_V3).toStrictEqual({
      admissionPolicyVersion: "https://jinn.network/task-admission/policy/3",
      observationsPerSide: 2,
      requireCandidateSpecConsistency: true,
      requireDeclaredTransitionsProven: true,
      requireEmptySideFailure: true,
      requireFailToPassPerPath: true,
      requireGloballyUniqueAssertionIds: true,
      requireInlineEnvironmentMatch: true,
    });
  });

  it("pins the namespaced EvaluationSpec key that carries the environment-record reference", () => {
    expect(ENVIRONMENT_RECORD_SPEC_KEY).toBe("network.jinn.environment.record");
  });
});
