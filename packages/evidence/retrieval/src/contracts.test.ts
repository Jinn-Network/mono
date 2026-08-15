import { describe, expect, expectTypeOf, test } from "vitest";

import {
  EVIDENCE_RETRIEVAL_FAILURE_CODES,
  EvidenceRetrievalError,
  createEvidenceRetrievalFailure,
  type CandidateSource,
  type EvidenceRetrieval,
  type QueryEvidenceInput,
  type ValidatedRecord,
} from "./index.js";

interface KeywordQuery {
  readonly text: string;
}

describe("Evidence Retrieval public contract", () => {
  test("keeps a source query statically paired with its provider", () => {
    expectTypeOf<QueryEvidenceInput<KeywordQuery, { score: number }>>()
      .toHaveProperty("candidateSource")
      .toEqualTypeOf<CandidateSource<KeywordQuery, { score: number }>>();
    expectTypeOf<EvidenceRetrieval["retrieve"]>().toBeFunction();
    expectTypeOf<ValidatedRecord["family"]>().toEqualTypeOf<
      "execution-evidence" | "result-evaluation" | "execution-verification"
    >();
  });

  test("uses stable typed failures without carrying content", () => {
    const failure = createEvidenceRetrievalFailure({
      code: "NO_LOCATION",
      stage: "location",
      message: "No allowed location was observed.",
    });
    expect(EVIDENCE_RETRIEVAL_FAILURE_CODES).toContain(failure.code);
    expect(Object.keys(failure).sort()).toEqual([
      "code",
      "message",
      "retryable",
      "stage",
    ]);
  });

  test("throws one typed error for invalid construction or input", () => {
    const error = new EvidenceRetrievalError(
      "INVALID_INPUT",
      "resultLimit must be a positive integer.",
    );
    expect(error).toMatchObject({
      name: "EvidenceRetrievalError",
      code: "INVALID_INPUT",
    });
  });
});
