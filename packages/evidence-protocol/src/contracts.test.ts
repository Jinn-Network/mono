import { describe, expect, it } from "vitest";

import {
  DSSE_PAYLOAD_TYPE,
  CONFORMANCE_DIAGNOSTIC_CODES,
  EXECUTION_EVIDENCE_PROFILE_URI,
  EXECUTION_VERIFICATION_PREDICATE_TYPE,
  ExecutionEvidenceDocumentSchema,
  IN_TOTO_STATEMENT_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  recordDigest,
  sha256Hex,
} from "./index.js";

describe("public contracts", () => {
  it("exports the stable protocol identifiers", () => {
    expect(EXECUTION_EVIDENCE_PROFILE_URI).toBe(
      "https://jinn.network/profiles/execution-evidence/1.0",
    );
    expect(RESULT_EVALUATION_PREDICATE_TYPE).toBe(
      "https://jinn.network/attestations/result-evaluation/v1",
    );
    expect(EXECUTION_VERIFICATION_PREDICATE_TYPE).toBe(
      "https://jinn.network/attestations/execution-verification/v1",
    );
    expect(IN_TOTO_STATEMENT_TYPE).toBe("https://in-toto.io/Statement/v1");
    expect(DSSE_PAYLOAD_TYPE).toBe("application/vnd.in-toto+json");
  });

  it("hashes the exact bytes with SHA-256", () => {
    const bytes = new TextEncoder().encode("execution evidence");
    expect(sha256Hex(bytes)).toBe(
      "56fd4b3d8e811bdafb7f188b5e41ebba0ed53df414f0fa0071b424d8bc03b746",
    );
    expect(recordDigest(bytes)).toBe(
      "sha256:56fd4b3d8e811bdafb7f188b5e41ebba0ed53df414f0fa0071b424d8bc03b746",
    );
  });

  it("preserves unknown extension fields in loose RO-Crate entities", () => {
    const document = ExecutionEvidenceDocumentSchema.parse({
      "@context": "https://w3id.org/ro/crate/1.3/context",
      "@graph": [
        {
          "@id": "ro-crate-metadata.json",
          "@type": "CreativeWork",
          "x-extension": { retained: true },
        },
      ],
      "x-document-extension": "retained",
    });

    expect(document["x-document-extension"]).toBe("retained");
    expect(document["@graph"][0]?.["x-extension"]).toEqual({ retained: true });
  });

  it("publishes stable machine-readable diagnostic codes", () => {
    expect(CONFORMANCE_DIAGNOSTIC_CODES).toContain("JSON_INVALID");
    expect(CONFORMANCE_DIAGNOSTIC_CODES).toContain(
      "DERIVATIVE_ROLE_SUBSTITUTION",
    );
    expect(CONFORMANCE_DIAGNOSTIC_CODES).toContain(
      "EVALUATION_SUBJECT_BINDING_INVALID",
    );
  });
});
