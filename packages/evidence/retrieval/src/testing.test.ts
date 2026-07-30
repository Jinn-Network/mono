import { expectTypeOf, test } from "vitest";

import {
  StaticCandidateSource,
  createSyntheticRetrievalFixture,
  describeCandidateSourceContract,
  describeEvidenceRetrievalContract,
  loadGoldenEvidenceRecords,
} from "./testing.js";

test("exports reusable fixtures and both contract kits", () => {
  expectTypeOf(StaticCandidateSource).toBeConstructibleWith(
    { id: "fixture", version: "1.0.0" },
    [],
  );
  expectTypeOf(createSyntheticRetrievalFixture).toBeFunction();
  expectTypeOf(describeCandidateSourceContract).toBeFunction();
  expectTypeOf(describeEvidenceRetrievalContract).toBeFunction();
  expectTypeOf(loadGoldenEvidenceRecords).toBeFunction();
});
