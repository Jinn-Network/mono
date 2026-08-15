import { describe, expect, test } from "vitest";

import { createEvidenceRetrieval } from "./retrieval.js";
import { facadeFixture } from "./test-support.js";

describe("createEvidenceRetrieval", () => {
  test("constructs one facade whose two operations share host ports and limits", async () => {
    const fixture = await facadeFixture();
    const retrieval = createEvidenceRetrieval(fixture.options);
    await expect(retrieval.retrieve({ reference: fixture.reference }))
      .resolves.toMatchObject({ status: "validated" });
    await expect(retrieval.query({
      candidateSource: fixture.source,
      sourceQuery: { text: "fixture" },
      resultLimit: 1,
      candidateBudget: 1,
    })).resolves.toMatchObject({
      results: [expect.objectContaining({ reference: fixture.reference })],
    });
  });

  test("rejects missing ports and over-limit operation input before I/O", () => {
    expect(() => createEvidenceRetrieval({} as never))
      .toThrowError(/locator, locationPolicy, and repositoryResolver/);
  });
});
