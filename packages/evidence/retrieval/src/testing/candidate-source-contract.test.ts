import { expect, vi } from "vitest";

import type { CandidateSource } from "../index.js";
import { describeCandidateSourceContract } from "./candidate-source-contract.js";
import { StaticCandidateSource, loadGoldenEvidenceRecords } from "./fixtures.js";

type Query = {
  readonly kind: "all" | "failure" | "timeout";
};

async function createCandidateContractFixture() {
  const records = await loadGoldenEvidenceRecords();
  const expectedReferences = [...records.values()].map(
    ({ reference }) => reference,
  );
  const base = new StaticCandidateSource<Query>(
    { id: "static-contract", version: "1.0.0" },
    expectedReferences.map((reference) => ({ reference })),
  );
  const source: CandidateSource<Query> = {
    identity: base.identity,
    async find(query, options) {
      if (query.kind === "failure") {
        throw new Error("Synthetic backend failure.");
      }
      if (query.kind === "timeout") {
        await new Promise((resolve) =>
          setTimeout(resolve, options.timeoutMs),
        );
        throw new DOMException("Synthetic timeout.", "TimeoutError");
      }
      return base.find(query, options);
    },
  };
  const unconfiguredAccess = vi.fn();
  return {
    source,
    query: { kind: "all" as const },
    failureQuery: { kind: "failure" as const },
    timeoutQuery: { kind: "timeout" as const },
    expectedReferences,
    assertAccessBoundary: () => {
      expect(unconfiguredAccess).not.toHaveBeenCalled();
    },
  };
}

describeCandidateSourceContract("StaticCandidateSource", async () => {
  const fixture = await createCandidateContractFixture();
  return fixture;
});
